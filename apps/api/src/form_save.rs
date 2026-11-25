//! Owner-scoped Forms create/update for the inbox-only pilot.
//!
//! One REST route, `POST /websites/{id}/forms`, forwards the caller's own
//! Supabase bearer with the publishable key to the existing `save_website_form`
//! RPC. `form_id` absent creates a form; present updates that form. The RPC
//! stays the authority for ownership, pilot approval, grants, field and host
//! rules; this module only mirrors the documented shape caps so obviously
//! invalid input is refused before any upstream call.
//!
//! The feature is default-off behind its own flag, `HTP_FORMS_OWNER_SAVE_API`,
//! and reuses the inbox pilot pair (`HTP_FORMS_PILOT_WEBSITE_ID` and
//! `HTP_FORMS_PILOT_OWNER_ID`), so only the pilot owner may save the pilot site.
//! No privileged key is used.
//!
//! Write outcomes are mapped conservatively. Only a status the RPC returns for a
//! definite refusal (401, 403, 404, or a 400 raised by the database) is reported
//! as a failed save. Anything else, including transport errors, timeouts, 5xx
//! responses and unparseable success bodies, is `save_unknown_outcome`, because
//! the write may have committed. For creates there is no idempotency key, so the
//! caller must reconcile the website's forms before any retry.

use axum::{
    Extension, Json, Router,
    extract::{
        Path, State,
        rejection::{JsonRejection, PathRejection},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;
use uuid::Uuid;

use crate::auth::AuthenticatedUser;
use crate::form_inbox::{PilotScope, pilot_from_env};

/// Environment flag. Only the exact value `true` enables the route. Distinct
/// from the inbox read flag so the two rollouts stay independent.
pub(crate) const ENABLE_VAR: &str = "HTP_FORMS_OWNER_SAVE_API";

pub(crate) fn enabled_from_env() -> bool {
    std::env::var(ENABLE_VAR).as_deref() == Ok("true")
}

/// Shape caps copied from the `save_website_form` contract (see docs/forms).
const MAX_FIELDS: usize = 32;
const MAX_HOSTS: usize = 16;
/// Canonical serialized form cap shared by REST and MCP, before any RPC.
pub(crate) const MAX_SAVE_BYTES: usize = 2 * 1024 * 1024;
/// Client deadline for the RPC, the same as the other user-scoped RPCs.
const RPC_DEADLINE: Duration = Duration::from_secs(10);

/// Stable, non-sensitive failure. Messages are fixed text, never upstream detail.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SaveError {
    pub code: &'static str,
    pub message: &'static str,
    pub status: StatusCode,
}

const NOT_ENABLED: SaveError = SaveError {
    code: "forms_owner_save_disabled",
    message: "Forms save API is not enabled on this server.",
    status: StatusCode::NOT_FOUND,
};
const NOT_FOUND: SaveError = SaveError {
    code: "not_found",
    message: "Not found or inaccessible.",
    status: StatusCode::NOT_FOUND,
};
const UNAUTHORIZED: SaveError = SaveError {
    code: "unauthorized",
    message: "Sign in again.",
    status: StatusCode::UNAUTHORIZED,
};
const INVALID: SaveError = SaveError {
    code: "invalid_request",
    message: "Invalid request. Check the form key, name, fields, hosts and form_id.",
    status: StatusCode::BAD_REQUEST,
};
const UNKNOWN_CREATE: SaveError = SaveError {
    code: "save_unknown_outcome",
    message: "The save outcome is unknown and a form may already have been created. Do not retry the create yet. List the website's forms to reconcile before any further action.",
    status: StatusCode::SERVICE_UNAVAILABLE,
};
const UNKNOWN_UPDATE: SaveError = SaveError {
    code: "save_unknown_outcome",
    message: "The save outcome is unknown. Do not assume it was saved or not saved. Reread the form before any further action.",
    status: StatusCode::SERVICE_UNAVAILABLE,
};

fn unknown_outcome(create: bool) -> SaveError {
    if create {
        UNKNOWN_CREATE
    } else {
        UNKNOWN_UPDATE
    }
}

/// Exact key rule from the RPC: `^[a-z][a-z0-9_]{0,63}$`.
fn valid_form_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
}

/// Schema-only field definition pinned to the save RPC contract. Keep JSON
/// deserialization and database validation authoritative for REST and MCP.
#[derive(rmcp::schemars::JsonSchema)]
#[schemars(deny_unknown_fields)]
#[allow(dead_code)]
struct SaveFieldSchema {
    #[schemars(length(min = 1, max = 64), regex(pattern = "^[a-z][a-z0-9_]{0,63}$"))]
    key: String,
    #[schemars(length(min = 1, max = 100))]
    label: String,
    kind: SaveFieldKindSchema,
    required: bool,
    #[schemars(range(min = 1, max = 5000))]
    max_length: u32,
}

#[derive(rmcp::schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code)]
enum SaveFieldKindSchema {
    Text,
    Email,
    Telephone,
    Multiline,
}

/// Request body. Unknown fields are refused, so the caller cannot smuggle
/// extra parameters past the contract. `form_id` absent means create.
#[derive(Debug, serde::Serialize, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct SaveBody {
    #[serde(default)]
    #[schemars(with = "Option<String>")]
    pub form_id: Option<Uuid>,
    pub form_key: String,
    pub name: String,
    #[schemars(with = "Vec<SaveFieldSchema>")]
    pub fields: Vec<Value>,
    pub active: bool,
    #[serde(default)]
    #[schemars(with = "Vec<String>")]
    pub host_ids: Vec<Uuid>,
}

/// Local shape checks that mirror the RPC caps. Field and name content is left
/// to the RPC, which is the authority.
fn validate(body: &SaveBody) -> Result<(), SaveError> {
    if !valid_form_key(&body.form_key)
        || !(1..=MAX_FIELDS).contains(&body.fields.len())
        || body.host_ids.len() > MAX_HOSTS
        || serde_json::to_vec(body).map_or(true, |bytes| bytes.len() > MAX_SAVE_BYTES)
    {
        return Err(INVALID);
    }
    Ok(())
}

/// Client for the one user-scoped write RPC. Redirects are disabled so the
/// bearer is never sent to another origin.
#[derive(Clone)]
pub(crate) struct FormSaver {
    project_url: String,
    publishable_key: String,
    client: reqwest::Client,
}

impl FormSaver {
    pub(crate) fn new(project_url: &str, publishable_key: &str) -> Self {
        Self {
            project_url: project_url.trim_end_matches('/').to_owned(),
            publishable_key: publishable_key.to_owned(),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("static reqwest client configuration"),
        }
    }

    /// Save one form as the caller. Returns the public projection of the row.
    pub(crate) async fn save(
        &self,
        headers: &HeaderMap,
        website_id: Uuid,
        body: &SaveBody,
    ) -> Result<Value, SaveError> {
        let create = body.form_id.is_none();
        let authorization = headers.get(header::AUTHORIZATION).ok_or(UNAUTHORIZED)?;
        let response = self
            .client
            .post(format!(
                "{}/rest/v1/rpc/save_website_form",
                self.project_url
            ))
            .header("apikey", &self.publishable_key)
            .header(header::AUTHORIZATION, authorization)
            .timeout(RPC_DEADLINE)
            .json(&json!({
                "p_website_id": website_id,
                "p_form_id": body.form_id,
                "p_form_key": body.form_key,
                "p_name": body.name,
                "p_fields": body.fields,
                "p_active": body.active,
                "p_host_ids": body.host_ids,
            }))
            .send()
            .await
            .map_err(|_| unknown_outcome(create))?;
        let status = response.status();
        // A body read failure after a 2xx means the outcome is not known.
        let bytes = response
            .bytes()
            .await
            .map_err(|_| unknown_outcome(create))?;
        if status == reqwest::StatusCode::OK {
            return saved_form(&bytes, body).ok_or(unknown_outcome(create));
        }
        Err(map_upstream_error(status, &bytes, create))
    }
}

/// Validate the RPC's success shape against the request before returning it.
/// Anything that does not match is an unknown outcome, never a success.
fn saved_form(bytes: &[u8], body: &SaveBody) -> Option<Value> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let id = Uuid::parse_str(value.get("id")?.as_str()?).ok()?;
    if body.form_id.is_some_and(|expected| expected != id) {
        return None;
    }
    if value.get("form_key")?.as_str()? != body.form_key {
        return None;
    }
    if value.get("active")?.as_bool()? != body.active {
        return None;
    }
    let name = value.get("name")?.as_str()?;
    let fields = value.get("fields")?;
    if !fields.is_array() {
        return None;
    }
    Some(json!({
        "id": id,
        "form_key": body.form_key,
        "name": name,
        "fields": fields,
        "active": body.active,
    }))
}

/// Map a non-200 RPC response. Only the statuses `PostgREST` uses for a refusal
/// that did not write are definite. Everything else may have committed.
fn map_upstream_error(status: reqwest::StatusCode, body: &[u8], create: bool) -> SaveError {
    match status {
        reqwest::StatusCode::UNAUTHORIZED => UNAUTHORIZED,
        reqwest::StatusCode::FORBIDDEN | reqwest::StatusCode::NOT_FOUND => NOT_FOUND,
        reqwest::StatusCode::BAD_REQUEST => {
            // Database raises roll back, so a 400 is a definite refusal. The
            // message is read only to pick a fixed code, never copied out.
            let message = serde_json::from_slice::<Value>(body)
                .ok()
                .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_owned))
                .unwrap_or_default();
            if message.contains("Website not found") || message.contains("Form not found") {
                NOT_FOUND
            } else {
                INVALID
            }
        }
        _ => unknown_outcome(create),
    }
}

/// Shared state. `enabled` and `pilot` are read once at startup.
#[derive(Clone)]
pub(crate) struct FormSaveState {
    pub(crate) saver: FormSaver,
    pub(crate) enabled: bool,
    pub(crate) pilot: Option<PilotScope>,
}

/// Authenticated REST route, merged behind `auth::require_user`:
///   POST `/websites/{id}/forms`  body `{form_id?, form_key, name, fields, active, host_ids?}`
pub(crate) fn router(state: FormSaveState) -> Router {
    Router::new()
        .route("/websites/{id}/forms", post(save_form))
        .with_state(state)
}

type Caller = Option<Extension<AuthenticatedUser>>;

async fn save_form(
    State(state): State<FormSaveState>,
    caller: Caller,
    headers: HeaderMap,
    path: Result<Path<Uuid>, PathRejection>,
    body: Result<Json<SaveBody>, JsonRejection>,
) -> Response {
    let result = async {
        ensure_enabled(&state)?;
        let website_id = path.map(|Path(id)| id).map_err(|_| INVALID)?;
        authorize(&state, caller.as_ref(), website_id)?;
        let Json(body) = body.map_err(|_| INVALID)?;
        validate(&body)?;
        state.saver.save(&headers, website_id, &body).await
    }
    .await;
    respond(result)
}

fn ensure_enabled(state: &FormSaveState) -> Result<(), SaveError> {
    if state.enabled && state.pilot.is_some() {
        Ok(())
    } else {
        Err(NOT_ENABLED)
    }
}

/// Pilot affinity, the same rule as the inbox reads: only the pilot website and
/// only the pilot owner. Anything else is not found, before any upstream call.
fn authorize(
    state: &FormSaveState,
    caller: Option<&Extension<AuthenticatedUser>>,
    website_id: Uuid,
) -> Result<(), SaveError> {
    ensure_enabled(state)?;
    let caller = caller.ok_or(UNAUTHORIZED)?;
    let pilot = state.pilot.ok_or(NOT_ENABLED)?;
    if website_id == pilot.website_id && caller.0.id == pilot.owner_id {
        Ok(())
    } else {
        Err(NOT_FOUND)
    }
}

/// Every response is no-store: a saved form carries submitted-form definitions
/// and the envelope matches the other owner Forms routes.
fn respond(result: Result<Value, SaveError>) -> Response {
    let (status, body) = match result {
        Ok(value) => (StatusCode::OK, value),
        Err(error) => (
            error.status,
            json!({"code": error.code, "error": error.message}),
        ),
    };
    (status, [(header::CACHE_CONTROL, "no-store")], Json(body)).into_response()
}

/// Enablement and pilot affinity read from the environment at startup.
pub(crate) fn state_from_env(saver: FormSaver) -> FormSaveState {
    FormSaveState {
        saver,
        enabled: enabled_from_env(),
        pilot: pilot_from_env(),
    }
}

use rmcp::handler::server::{tool::Extension as ToolExtension, wrapper::Parameters};
use rmcp::model::CallToolResult;
use rmcp::schemars;
use rmcp::{tool, tool_router};

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct SaveFormInput {
    #[schemars(with = "String")]
    website_id: Uuid,
    form: SaveBody,
}
#[tool_router(router = forms_save_tool_router, vis = "pub(crate)")]
impl crate::mcp::WebsiteMcp {
    #[tool(
        description = "Save an inactive or active form for the scoped pilot website. Omit form_id to create; supply it to update. Activation requires verified host grants and database validation. On unknown outcome, list forms to reconcile before any further action; never blindly retry a create. Default-off; visible to signed-in users when configured, executable only by the pilot owner.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false
        )
    )]
    async fn save_website_form(
        &self,
        Parameters(input): Parameters<SaveFormInput>,
        ToolExtension(parts): ToolExtension<axum::http::request::Parts>,
    ) -> CallToolResult {
        crate::mcp::forms_result(
            save_form(
                State(self.save.clone()),
                parts
                    .extensions
                    .get::<AuthenticatedUser>()
                    .cloned()
                    .map(Extension),
                parts.headers,
                Ok(Path(input.website_id)),
                Ok(Json(input.form)),
            )
            .await,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_payload_canonical_byte_boundary() {
        let mut body: SaveBody = serde_json::from_value(serde_json::json!({
            "form_key":"contact","name":"","fields":[{}],"active":false
        }))
        .unwrap();
        let overhead = serde_json::to_vec(&body).unwrap().len();
        body.name = "x".repeat(MAX_SAVE_BYTES - overhead);
        assert_eq!(serde_json::to_vec(&body).unwrap().len(), MAX_SAVE_BYTES);
        assert_eq!(validate(&body), Ok(()));
        body.name.push('x');
        assert_eq!(validate(&body), Err(INVALID));
        // Escaping is measured as serialized bytes, not source characters.
        body.name = "\"".repeat(MAX_SAVE_BYTES / 2);
        assert_eq!(validate(&body), Err(INVALID));
    }

    use axum::{
        Router,
        body::Body,
        extract::State as AxState,
        http::{Method, Request},
        routing::post as axpost,
    };
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    use tower::ServiceExt as _;

    const SITE: &str = "00000000-0000-0000-0000-000000000001";
    const FORM: &str = "00000000-0000-0000-0000-000000000002";
    const OWNER: &str = "00000000-0000-0000-0000-0000000000aa";
    const OTHER_SITE: &str = "00000000-0000-0000-0000-0000000000bb";
    const OTHER_OWNER: &str = "00000000-0000-0000-0000-0000000000cc";
    const HOST: &str = "00000000-0000-0000-0000-0000000000dd";
    const NEW_FORM: &str = "00000000-0000-0000-0000-0000000000ee";

    fn uuid(value: &str) -> Uuid {
        Uuid::parse_str(value).unwrap()
    }

    fn pilot() -> PilotScope {
        PilotScope {
            website_id: uuid(SITE),
            owner_id: uuid(OWNER),
        }
    }

    fn valid_body() -> Value {
        json!({
            "form_key": "quote",
            "name": "Quote",
            "fields": [{"key": "name", "label": "Name", "kind": "text", "required": true, "max_length": 100}],
            "active": false,
            "host_ids": [],
        })
    }

    #[derive(Clone, Copy)]
    enum Reply {
        /// Echo the request back as the RPC row would look.
        Echo,
        Raw(StatusCode, &'static str),
    }

    #[derive(Clone)]
    struct Upstream {
        reply: Reply,
        /// Upstream requests seen. Tests use it to prove no upstream call happened.
        hits: Arc<AtomicUsize>,
        /// Exact RPC bodies received, for checking the forwarded parameters.
        seen: Arc<Mutex<Vec<Value>>>,
    }

    /// A local `PostgREST` stand-in. It answers only with the caller's bearer and
    /// the publishable key, which is how the real RPC would be reached.
    async fn rpc(
        AxState(up): AxState<Upstream>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> Response {
        up.hits.fetch_add(1, Ordering::SeqCst);
        if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some("Bearer owner-token")
            || headers.get("apikey").and_then(|v| v.to_str().ok()) != Some("test-publishable")
        {
            return (StatusCode::UNAUTHORIZED, "{}").into_response();
        }
        up.seen.lock().unwrap().push(body.clone());
        match up.reply {
            Reply::Echo => Json(json!({
                "id": body["p_form_id"].as_str().unwrap_or(NEW_FORM),
                "website_id": body["p_website_id"],
                "form_key": body["p_form_key"],
                "name": body["p_name"],
                "fields": body["p_fields"],
                "active": body["p_active"],
            }))
            .into_response(),
            Reply::Raw(status, text) => {
                (status, [(header::CONTENT_TYPE, "application/json")], text).into_response()
            }
        }
    }

    struct Fixture {
        saver: FormSaver,
        up: Upstream,
    }

    async fn fixture(reply: Reply) -> Fixture {
        let up = Upstream {
            reply,
            hits: Arc::new(AtomicUsize::new(0)),
            seen: Arc::new(Mutex::new(Vec::new())),
        };
        let app = Router::new()
            .route("/rest/v1/rpc/save_website_form", axpost(rpc))
            .with_state(up.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Fixture {
            saver: FormSaver::new(&origin, "test-publishable"),
            up,
        }
    }

    fn app(enabled: bool, pilot: Option<PilotScope>, saver: FormSaver) -> Router {
        router(FormSaveState {
            saver,
            enabled,
            pilot,
        })
    }

    /// Sends one request as the given caller, injected the way `require_user` would.
    async fn send(
        app: Router,
        method: Method,
        uri: &str,
        caller: Option<&str>,
        body: &str,
    ) -> (StatusCode, HeaderMap, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", "Bearer owner-token")
            .header("content-type", "application/json")
            .body(Body::from(body.to_owned()))
            .unwrap();
        if let Some(id) = caller {
            request
                .extensions_mut()
                .insert(AuthenticatedUser { id: uuid(id) });
        }
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        (
            status,
            headers,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn post_uri(website: &str) -> String {
        format!("/websites/{website}/forms")
    }

    #[test]
    fn default_off_and_pilot_pair_fail_closed() {
        let state = FormSaveState {
            saver: FormSaver::new("http://127.0.0.1:1", "test-publishable"),
            enabled: false,
            pilot: Some(pilot()),
        };
        assert_eq!(ensure_enabled(&state), Err(NOT_ENABLED));
        let state = FormSaveState {
            enabled: true,
            pilot: None,
            ..state
        };
        assert_eq!(ensure_enabled(&state), Err(NOT_ENABLED));
        assert_eq!(NOT_ENABLED.status, StatusCode::NOT_FOUND);
    }

    #[test]
    fn form_key_matches_the_rpc_pattern_exactly() {
        assert!(valid_form_key("a"));
        assert!(valid_form_key("quote_request_2"));
        assert!(valid_form_key(&format!("a{}", "b".repeat(63))));
        assert!(!valid_form_key(&format!("a{}", "b".repeat(64))));
        assert!(!valid_form_key(""));
        assert!(!valid_form_key("Quote"));
        assert!(!valid_form_key("1quote"));
        assert!(!valid_form_key("quote-request"));
        assert!(!valid_form_key("_quote"));
    }

    #[test]
    fn field_schema_annotation_does_not_change_json_deserialization() {
        // Invalid definitions still reach the database's authoritative validator.
        let mut input = valid_body();
        input["fields"] = json!(["name", {"future_property": true}]);
        let body: SaveBody = serde_json::from_value(input.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(&body).unwrap()["fields"],
            input["fields"]
        );
        assert!(validate(&body).is_ok());
    }

    #[test]
    fn shape_caps_mirror_the_rpc() {
        let mut body: SaveBody = serde_json::from_value(valid_body()).unwrap();
        assert!(validate(&body).is_ok());
        body.fields = vec![json!({}); MAX_FIELDS + 1];
        assert_eq!(validate(&body), Err(INVALID));
        body.fields = Vec::new();
        assert_eq!(validate(&body), Err(INVALID));
        body.fields = vec![json!({})];
        body.host_ids = (0..=MAX_HOSTS).map(|_| Uuid::nil()).collect();
        assert_eq!(validate(&body), Err(INVALID));
    }

    #[tokio::test]
    async fn disabled_is_404_no_store_and_never_upstream() {
        let fixture = fixture(Reply::Echo).await;
        let app = app(false, Some(pilot()), fixture.saver.clone());
        let uris = [post_uri(SITE), post_uri("not-a-uuid")];
        for uri in uris {
            // Malformed bodies are also disabled, so the gate is checked first.
            for body in [valid_body().to_string(), "not json".to_owned()] {
                let (status, headers, value) =
                    send(app.clone(), Method::POST, &uri, Some(OWNER), &body).await;
                assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
                assert_eq!(headers[header::CACHE_CONTROL], "no-store", "{uri}");
                assert_eq!(value["code"], json!("forms_owner_save_disabled"), "{uri}");
            }
        }
        assert_eq!(fixture.up.hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn malformed_requests_are_invalid_no_store_and_never_upstream() {
        let fixture = fixture(Reply::Echo).await;
        let app = app(true, Some(pilot()), fixture.saver.clone());
        let mut bad_fields = valid_body();
        bad_fields["fields"] = json!([]);
        let mut too_many_fields = valid_body();
        too_many_fields["fields"] = json!(vec![json!({}); MAX_FIELDS + 1]);
        let mut bad_key = valid_body();
        bad_key["form_key"] = json!("Bad-Key");
        let mut too_many_hosts = valid_body();
        too_many_hosts["host_ids"] = json!(vec![HOST; MAX_HOSTS + 1]);
        let mut unknown_field = valid_body();
        unknown_field["website_id"] = json!(OTHER_SITE);
        let mut missing_active = valid_body();
        missing_active.as_object_mut().unwrap().remove("active");
        let mut bad_form_id = valid_body();
        bad_form_id["form_id"] = json!("not-a-uuid");
        let bodies = [
            "not json".to_owned(),
            bad_fields.to_string(),
            too_many_fields.to_string(),
            bad_key.to_string(),
            too_many_hosts.to_string(),
            unknown_field.to_string(),
            missing_active.to_string(),
            bad_form_id.to_string(),
        ];
        for body in bodies {
            let (status, headers, value) = send(
                app.clone(),
                Method::POST,
                &post_uri(SITE),
                Some(OWNER),
                &body,
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
            assert_eq!(headers[header::CACHE_CONTROL], "no-store", "{body}");
            assert_eq!(value["code"], json!("invalid_request"), "{body}");
        }
        let (status, _, value) = send(
            app,
            Method::POST,
            &post_uri("not-a-uuid"),
            Some(OWNER),
            &valid_body().to_string(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(value["code"], json!("invalid_request"));
        assert_eq!(fixture.up.hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn non_pilot_website_owner_and_missing_caller_never_upstream() {
        let fixture = fixture(Reply::Echo).await;
        let app = app(true, Some(pilot()), fixture.saver.clone());
        let body = valid_body().to_string();

        let (status, headers, value) = send(
            app.clone(),
            Method::POST,
            &post_uri(OTHER_SITE),
            Some(OWNER),
            &body,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert_eq!(value["code"], json!("not_found"));

        let (status, _, value) = send(
            app.clone(),
            Method::POST,
            &post_uri(SITE),
            Some(OTHER_OWNER),
            &body,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(value["code"], json!("not_found"));

        let (status, headers, value) = send(app, Method::POST, &post_uri(SITE), None, &body).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert_eq!(value["code"], json!("unauthorized"));
        assert_eq!(fixture.up.hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn create_forwards_caller_bearer_with_null_form_id() {
        let fixture = fixture(Reply::Echo).await;
        let app = app(true, Some(pilot()), fixture.saver.clone());
        let (status, headers, value) = send(
            app,
            Method::POST,
            &post_uri(SITE),
            Some(OWNER),
            &valid_body().to_string(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert_eq!(value["id"], json!(NEW_FORM));
        assert_eq!(value["form_key"], json!("quote"));
        assert_eq!(value["active"], json!(false));
        assert!(
            value.get("website_id").is_none(),
            "projection must not echo extra columns"
        );

        let seen = fixture.up.seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0]["p_website_id"], json!(SITE));
        assert_eq!(seen[0]["p_form_id"], Value::Null);
        assert_eq!(seen[0]["p_form_key"], json!("quote"));
        assert_eq!(seen[0]["p_host_ids"], json!([]));
    }

    #[tokio::test]
    async fn update_forwards_form_id_and_returns_same_form() {
        let fixture = fixture(Reply::Echo).await;
        let app = app(true, Some(pilot()), fixture.saver.clone());
        let mut body = valid_body();
        body["form_id"] = json!(FORM);
        body["host_ids"] = json!([HOST]);
        body["active"] = json!(true);
        let (status, headers, value) = send(
            app,
            Method::POST,
            &post_uri(SITE),
            Some(OWNER),
            &body.to_string(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert_eq!(value["id"], json!(FORM));
        let seen = fixture.up.seen.lock().unwrap().clone();
        assert_eq!(seen[0]["p_form_id"], json!(FORM));
        assert_eq!(seen[0]["p_host_ids"], json!([HOST]));
        assert_eq!(seen[0]["p_active"], json!(true));
    }

    #[tokio::test]
    async fn definite_refusals_map_to_fixed_typed_codes() {
        let cases = [
            (
                StatusCode::BAD_REQUEST,
                r#"{"message":"Invalid field definition"}"#,
                StatusCode::BAD_REQUEST,
                "invalid_request",
            ),
            (
                StatusCode::BAD_REQUEST,
                r#"{"message":"Host not found or not verified"}"#,
                StatusCode::BAD_REQUEST,
                "invalid_request",
            ),
            (
                StatusCode::BAD_REQUEST,
                r#"{"message":"Form not found"}"#,
                StatusCode::NOT_FOUND,
                "not_found",
            ),
            (
                StatusCode::FORBIDDEN,
                r#"{"message":"Website not found"}"#,
                StatusCode::NOT_FOUND,
                "not_found",
            ),
            (
                StatusCode::UNAUTHORIZED,
                r#"{"message":"JWT expired"}"#,
                StatusCode::UNAUTHORIZED,
                "unauthorized",
            ),
        ];
        for (upstream, text, expected_status, code) in cases {
            let fixture = fixture(Reply::Raw(upstream, text)).await;
            let app = app(true, Some(pilot()), fixture.saver.clone());
            let (status, headers, value) = send(
                app,
                Method::POST,
                &post_uri(SITE),
                Some(OWNER),
                &valid_body().to_string(),
            )
            .await;
            assert_eq!(status, expected_status, "{text}");
            assert_eq!(headers[header::CACHE_CONTROL], "no-store", "{text}");
            assert_eq!(value["code"], json!(code), "{text}");
            assert!(
                !value.to_string().contains("Invalid field"),
                "upstream text must not leak"
            );
            assert!(
                !value.to_string().contains("JWT"),
                "upstream text must not leak"
            );
        }
    }

    #[tokio::test]
    async fn ambiguous_outcomes_are_unknown_and_distinguish_create_from_update() {
        let server_error = Reply::Raw(StatusCode::INTERNAL_SERVER_ERROR, r#"{"message":"boom"}"#);
        let fixture = fixture(server_error).await;
        let app = app(true, Some(pilot()), fixture.saver.clone());
        let (create_status, headers, create) = send(
            app.clone(),
            Method::POST,
            &post_uri(SITE),
            Some(OWNER),
            &valid_body().to_string(),
        )
        .await;
        assert_eq!(create_status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert_eq!(create["code"], json!("save_unknown_outcome"));
        assert!(
            !create.to_string().contains("boom"),
            "upstream text must not leak"
        );

        let mut update = valid_body();
        update["form_id"] = json!(FORM);
        let (status, _, value) = send(
            app,
            Method::POST,
            &post_uri(SITE),
            Some(OWNER),
            &update.to_string(),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(value["code"], json!("save_unknown_outcome"));
        assert_ne!(
            create["error"], value["error"],
            "create and update guidance differ"
        );
        assert!(
            create["error"]
                .as_str()
                .unwrap()
                .contains("Do not retry the create")
        );
    }

    #[tokio::test]
    async fn success_shape_mismatch_is_unknown_not_success() {
        let cases = [
            Reply::Raw(StatusCode::OK, "[]"),
            Reply::Raw(
                StatusCode::OK,
                r#"{"id":"not-a-uuid","form_key":"quote","name":"Quote","fields":[],"active":false}"#,
            ),
            Reply::Raw(
                StatusCode::OK,
                r#"{"id":"00000000-0000-0000-0000-0000000000ee","form_key":"other","name":"Quote","fields":[],"active":false}"#,
            ),
            Reply::Raw(StatusCode::CREATED, "{}"),
        ];
        for reply in cases {
            let fixture = fixture(reply).await;
            let app = app(true, Some(pilot()), fixture.saver.clone());
            let (status, _, value) = send(
                app,
                Method::POST,
                &post_uri(SITE),
                Some(OWNER),
                &valid_body().to_string(),
            )
            .await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(value["code"], json!("save_unknown_outcome"));
        }
    }

    #[tokio::test]
    async fn update_with_a_different_id_in_the_success_body_is_unknown() {
        let fixture = fixture(Reply::Raw(StatusCode::OK, r#"{"id":"00000000-0000-0000-0000-0000000000ee","form_key":"quote","name":"Quote","fields":[],"active":false}"#)).await;
        let app = app(true, Some(pilot()), fixture.saver.clone());
        let mut update = valid_body();
        update["form_id"] = json!(FORM);
        let (status, _, value) = send(
            app,
            Method::POST,
            &post_uri(SITE),
            Some(OWNER),
            &update.to_string(),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(value["code"], json!("save_unknown_outcome"));
    }

    #[tokio::test]
    async fn transport_failure_is_unknown_outcome_without_detail() {
        let saver = FormSaver::new("http://127.0.0.1:1", "test-publishable");
        let app = app(true, Some(pilot()), saver);
        let (status, headers, value) = send(
            app,
            Method::POST,
            &post_uri(SITE),
            Some(OWNER),
            &valid_body().to_string(),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert_eq!(value["code"], json!("save_unknown_outcome"));
        assert!(!value.to_string().contains("127.0.0.1"));
    }

    #[tokio::test]
    async fn route_coexists_with_the_inbox_read_on_the_same_path() {
        let fixture = fixture(Reply::Echo).await;
        let reader =
            crate::form_inbox::FormInboxReader::new("http://127.0.0.1:1", "test-publishable");
        let merged = Router::new()
            .merge(crate::form_inbox::router(
                crate::form_inbox::FormInboxState {
                    reader,
                    enabled: true,
                    pilot: Some(pilot()),
                },
            ))
            .merge(app(true, Some(pilot()), fixture.saver.clone()));
        // GET still reaches the inbox handler, and POST reaches this save handler.
        let (get_status, _, get_value) = send(
            merged.clone(),
            Method::GET,
            &post_uri(SITE),
            Some(OWNER),
            "",
        )
        .await;
        assert_eq!(get_status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(get_value["code"], json!("inbox_unavailable"));
        let (post_status, _, post_value) = send(
            merged,
            Method::POST,
            &post_uri(SITE),
            Some(OWNER),
            &valid_body().to_string(),
        )
        .await;
        assert_eq!(post_status, StatusCode::OK);
        assert_eq!(post_value["id"], json!(NEW_FORM));
        assert_eq!(fixture.up.hits.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn pilot_owner_is_the_only_caller_for_the_pilot_site() {
        let state = FormSaveState {
            saver: FormSaver::new("http://127.0.0.1:1", "test-publishable"),
            enabled: true,
            pilot: Some(pilot()),
        };
        let owner = Extension(AuthenticatedUser { id: uuid(OWNER) });
        let other = Extension(AuthenticatedUser {
            id: uuid(OTHER_OWNER),
        });
        assert!(authorize(&state, Some(&owner), uuid(SITE)).is_ok());
        assert_eq!(authorize(&state, Some(&other), uuid(SITE)), Err(NOT_FOUND));
        assert_eq!(
            authorize(&state, Some(&owner), uuid(OTHER_SITE)),
            Err(NOT_FOUND)
        );
        assert_eq!(authorize(&state, None, uuid(SITE)), Err(UNAUTHORIZED));
    }
}
