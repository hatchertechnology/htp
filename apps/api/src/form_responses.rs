//! Typed, default-off owner response management. Database pilot/owner gates,
//! grants, deletion locks and tombstones remain authoritative.
use axum::{
    Extension, Json, Router,
    body::Bytes,
    extract::{
        Path, State,
        rejection::{JsonRejection, PathRejection},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{delete, patch},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;
use uuid::Uuid;

use crate::{
    auth::AuthenticatedUser,
    form_inbox::{PilotScope, pilot_from_env},
};

const ENABLE_VAR: &str = "HTP_FORMS_OWNER_RESPONSE_API";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ResponseStatus {
    New,
    Reviewed,
    Spam,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StatusBody {
    status: ResponseStatus,
}

#[derive(Clone, Copy, Debug, Deserialize)]
struct ResponseIds {
    id: Uuid,
    form_id: Uuid,
    response_id: Uuid,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WriteError(StatusCode, &'static str, &'static str);
const DISABLED: WriteError = WriteError(
    StatusCode::NOT_FOUND,
    "forms_owner_response_disabled",
    "Forms response management API is not enabled on this server.",
);
const NOT_FOUND: WriteError = WriteError(
    StatusCode::NOT_FOUND,
    "not_found",
    "Not found or inaccessible.",
);
const UNAUTHORIZED: WriteError =
    WriteError(StatusCode::UNAUTHORIZED, "unauthorized", "Sign in again.");
const INVALID: WriteError = WriteError(
    StatusCode::BAD_REQUEST,
    "invalid_request",
    "Use UUID ids and a status of new, reviewed or spam. DELETE accepts no body.",
);
const BUSY: WriteError = WriteError(
    StatusCode::CONFLICT,
    "response_notification_sending",
    "A notification is sending. The response was not deleted. Reconcile notification state before another explicit attempt.",
);

#[derive(Clone, Copy)]
enum Operation {
    Status(ResponseStatus),
    Delete,
}
impl Operation {
    fn unknown(self) -> WriteError {
        match self {
            Self::Status(_) => WriteError(
                StatusCode::SERVICE_UNAVAILABLE,
                "response_status_unknown_outcome",
                "The status may or may not have changed. Reread the response before another explicit attempt. The request was not retried.",
            ),
            Self::Delete => WriteError(
                StatusCode::SERVICE_UNAVAILABLE,
                "response_delete_unknown_outcome",
                "The response may or may not have been deleted. Reread the inbox before another explicit attempt. The request was not retried.",
            ),
        }
    }
}

#[derive(Clone)]
pub(crate) struct ResponseWriter {
    project_url: String,
    publishable_key: String,
    client: reqwest::Client,
}
impl ResponseWriter {
    pub(crate) fn new(project_url: &str, publishable_key: &str) -> Self {
        Self {
            project_url: project_url.trim_end_matches('/').to_owned(),
            publishable_key: publishable_key.to_owned(),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .build()
                .expect("static reqwest client configuration"),
        }
    }

    // Closed operation enum: no caller-selected RPC names or arbitrary parameters.
    async fn write(
        &self,
        headers: &HeaderMap,
        ids: ResponseIds,
        operation: Operation,
    ) -> Result<Value, WriteError> {
        let authorization = headers.get(header::AUTHORIZATION).ok_or(UNAUTHORIZED)?;
        let mut params = json!({"p_website_id": ids.id, "p_form_id": ids.form_id, "p_response_id": ids.response_id});
        let rpc = match operation {
            Operation::Status(status) => {
                params["p_status"] = json!(status);
                "set_website_form_response_status"
            }
            Operation::Delete => "delete_website_form_response",
        };
        let response = self
            .client
            .post(format!("{}/rest/v1/rpc/{rpc}", self.project_url))
            .header("apikey", &self.publishable_key)
            .header(header::AUTHORIZATION, authorization)
            .timeout(Duration::from_secs(10))
            .json(&params)
            .send()
            .await
            .map_err(|_| operation.unknown())?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(|_| operation.unknown())?;
        if status != StatusCode::OK {
            return Err(map_error(status, &bytes, operation));
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| operation.unknown())?;
        match operation {
            Operation::Delete if value == json!(true) => {
                Ok(json!({"id": ids.response_id, "deleted": true}))
            }
            Operation::Status(status) => {
                // The RPC returns the full row. Validate exact affinity then expose only management metadata.
                for (key, expected) in [
                    ("id", ids.response_id),
                    ("website_id", ids.id),
                    ("form_id", ids.form_id),
                ] {
                    if value
                        .get(key)
                        .and_then(Value::as_str)
                        .and_then(|v| Uuid::parse_str(v).ok())
                        != Some(expected)
                    {
                        return Err(operation.unknown());
                    }
                }
                if value.get("status") != Some(&json!(status)) {
                    return Err(operation.unknown());
                }
                Ok(json!({"id": ids.response_id, "status": status}))
            }
            _ => Err(operation.unknown()),
        }
    }
}

fn map_error(status: StatusCode, bytes: &[u8], operation: Operation) -> WriteError {
    let code = serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|v| v.get("code").and_then(Value::as_str).map(str::to_owned));
    match status {
        StatusCode::UNAUTHORIZED => UNAUTHORIZED,
        StatusCode::FORBIDDEN | StatusCode::NOT_FOUND => NOT_FOUND,
        // Only known database raises establish a rolled-back refusal. In particular,
        // 55000 maps to HTTP 500 in PostgREST; other 5xx remain ambiguous.
        StatusCode::BAD_REQUEST if code.as_deref() == Some("22023") => INVALID,
        StatusCode::INTERNAL_SERVER_ERROR
            if code.as_deref() == Some("55000") && matches!(operation, Operation::Delete) =>
        {
            BUSY
        }
        _ => operation.unknown(),
    }
}

#[derive(Clone)]
pub(crate) struct ResponseState {
    pub(crate) writer: ResponseWriter,
    pub(crate) enabled: bool,
    pub(crate) pilot: Option<PilotScope>,
}
pub(crate) fn state_from_env(writer: ResponseWriter) -> ResponseState {
    ResponseState {
        writer,
        enabled: std::env::var(ENABLE_VAR).as_deref() == Ok("true"),
        pilot: pilot_from_env(),
    }
}
pub(crate) fn router(state: ResponseState) -> Router {
    Router::new()
        .route(
            "/websites/{id}/forms/{form_id}/responses/{response_id}/status",
            patch(set_status),
        )
        .route(
            "/websites/{id}/forms/{form_id}/responses/{response_id}",
            delete(delete_response),
        )
        .with_state(state)
}

type Caller = Option<Extension<AuthenticatedUser>>;
fn authorize(
    state: &ResponseState,
    caller: Caller,
    path: Result<Path<ResponseIds>, PathRejection>,
) -> Result<ResponseIds, WriteError> {
    if !state.enabled || state.pilot.is_none() {
        return Err(DISABLED);
    }
    let ids = path.map_err(|_| INVALID)?.0;
    let caller = caller.ok_or(UNAUTHORIZED)?;
    let pilot = state.pilot.ok_or(DISABLED)?;
    if ids.id != pilot.website_id || caller.0.id != pilot.owner_id {
        return Err(NOT_FOUND);
    }
    Ok(ids)
}
async fn set_status(
    State(state): State<ResponseState>,
    caller: Caller,
    headers: HeaderMap,
    path: Result<Path<ResponseIds>, PathRejection>,
    body: Result<Json<StatusBody>, JsonRejection>,
) -> Response {
    let result = async {
        let ids = authorize(&state, caller, path)?;
        let Json(body) = body.map_err(|_| INVALID)?;
        state
            .writer
            .write(&headers, ids, Operation::Status(body.status))
            .await
    }
    .await;
    respond(result)
}
async fn delete_response(
    State(state): State<ResponseState>,
    caller: Caller,
    headers: HeaderMap,
    path: Result<Path<ResponseIds>, PathRejection>,
    body: Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Response {
    let result = async {
        let ids = authorize(&state, caller, path)?;
        if !body.map_err(|_| INVALID)?.is_empty() {
            return Err(INVALID);
        }
        state.writer.write(&headers, ids, Operation::Delete).await
    }
    .await;
    respond(result)
}
fn respond(result: Result<Value, WriteError>) -> Response {
    let (status, body) = match result {
        Ok(value) => (StatusCode::OK, value),
        Err(WriteError(status, code, message)) => (status, json!({"code": code, "error": message})),
    };
    (status, [(header::CACHE_CONTROL, "no-store")], Json(body)).into_response()
}

use rmcp::handler::server::{tool::Extension as ToolExtension, wrapper::Parameters};
use rmcp::model::CallToolResult;
use rmcp::schemars;
use rmcp::{tool, tool_router};

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct DeleteResponseInput {
    #[schemars(with = "String")]
    website_id: Uuid,
    #[schemars(with = "String")]
    form_id: Uuid,
    #[schemars(with = "String")]
    response_id: Uuid,
    /// Must be true after explicit user intent to permanently delete this exact response.
    confirm_delete: bool,
}
#[tool_router(router = forms_response_tool_router, vis = "pub(crate)")]
impl crate::mcp::WebsiteMcp {
    #[tool(
        description = "Permanently delete exactly one explicitly selected pilot form response. Requires explicit user intent and confirm_delete=true. No bulk deletion. Unknown outcomes require inbox reconciliation before another explicit attempt. Default-off; visible to signed-in users when configured, executable only by the pilot owner.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false
        )
    )]
    async fn delete_form_response(
        &self,
        Parameters(input): Parameters<DeleteResponseInput>,
        ToolExtension(parts): ToolExtension<axum::http::request::Parts>,
    ) -> CallToolResult {
        if !input.confirm_delete {
            return CallToolResult::structured_error(
                json!({"code":"explicit_delete_required","error":"Confirm explicit intent to delete this exact response."}),
            );
        }
        crate::mcp::forms_result(
            delete_response(
                State(self.responses.clone()),
                parts
                    .extensions
                    .get::<AuthenticatedUser>()
                    .cloned()
                    .map(Extension),
                parts.headers,
                Ok(Path(ResponseIds {
                    id: input.website_id,
                    form_id: input.form_id,
                    response_id: input.response_id,
                })),
                Ok(Bytes::new()),
            )
            .await,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Method, Request},
        middleware,
        routing::post,
    };
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt as _;

    const SITE: &str = "00000000-0000-0000-0000-000000000001";
    const FORM: &str = "00000000-0000-0000-0000-000000000002";
    const ROW: &str = "00000000-0000-0000-0000-000000000003";
    const OWNER: &str = "00000000-0000-0000-0000-000000000004";
    const OTHER: &str = "00000000-0000-0000-0000-000000000005";
    fn uuid(s: &str) -> Uuid {
        Uuid::parse_str(s).unwrap()
    }
    fn pilot() -> PilotScope {
        PilotScope {
            website_id: uuid(SITE),
            owner_id: uuid(OWNER),
        }
    }
    fn path(site: &str, status: bool) -> String {
        format!(
            "/websites/{site}/forms/{FORM}/responses/{ROW}{}",
            if status { "/status" } else { "" }
        )
    }
    type Seen = Arc<Mutex<Vec<(String, HeaderMap, Value)>>>;
    #[derive(Clone)]
    struct Upstream {
        seen: Seen,
        reply: Option<(StatusCode, String)>,
    }
    async fn rpc(
        State(up): State<Upstream>,
        Path(rpc): Path<String>,
        headers: HeaderMap,
        Json(params): Json<Value>,
    ) -> Response {
        up.seen
            .lock()
            .unwrap()
            .push((rpc.clone(), headers, params.clone()));
        if let Some((status, body)) = up.reply {
            return (status, body).into_response();
        }
        match rpc.as_str() {
            "set_website_form_response_status" => Json(json!({"id": params["p_response_id"], "website_id": params["p_website_id"], "form_id": params["p_form_id"], "status": params["p_status"], "values": {"private": "must not echo"}})).into_response(),
            "delete_website_form_response" => Json(json!(true)).into_response(),
            _ => panic!("unexpected RPC"),
        }
    }
    async fn fixture(reply: Option<(StatusCode, String)>) -> (ResponseState, Seen) {
        let seen = Seen::default();
        let app = Router::new()
            .route("/rest/v1/rpc/{rpc}", post(rpc))
            .with_state(Upstream {
                seen: seen.clone(),
                reply,
            });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (
            ResponseState {
                writer: ResponseWriter::new(&origin, "synthetic-publishable"),
                enabled: true,
                pilot: Some(pilot()),
            },
            seen,
        )
    }
    async fn send(
        app: Router,
        method: Method,
        uri: &str,
        owner: Option<&str>,
        bearer: bool,
        body: &str,
    ) -> (StatusCode, HeaderMap, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ORIGIN, "https://dashboard.example")
            .body(Body::from(body.to_owned()))
            .unwrap();
        if bearer {
            request.headers_mut().insert(
                header::AUTHORIZATION,
                "Bearer synthetic-owner".parse().unwrap(),
            );
        }
        if let Some(owner) = owner {
            request
                .extensions_mut()
                .insert(AuthenticatedUser { id: uuid(owner) });
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
    fn operations() -> [(Method, bool, &'static str); 2] {
        [
            (Method::PATCH, true, r#"{"status":"reviewed"}"#),
            (Method::DELETE, false, ""),
        ]
    }
    #[tokio::test]
    async fn gates_and_scope_refuse_before_upstream() {
        let (state, seen) = fixture(None).await;
        for (method, status_path, body) in operations() {
            for (enabled, scope, owner, site, bearer, expected) in [
                (false, Some(pilot()), Some(OWNER), SITE, true, DISABLED),
                (true, None, Some(OWNER), SITE, true, DISABLED),
                (true, Some(pilot()), Some(OTHER), SITE, true, NOT_FOUND),
                (true, Some(pilot()), Some(OWNER), OTHER, true, NOT_FOUND),
                (true, Some(pilot()), None, SITE, true, UNAUTHORIZED),
                (true, Some(pilot()), Some(OWNER), SITE, false, UNAUTHORIZED),
            ] {
                let app = router(ResponseState {
                    enabled,
                    pilot: scope,
                    ..state.clone()
                });
                let (status, headers, value) = send(
                    app,
                    method.clone(),
                    &path(site, status_path),
                    owner,
                    bearer,
                    body,
                )
                .await;
                assert_eq!(status, expected.0);
                assert_eq!(value["code"], expected.1);
                assert_eq!(headers[header::CACHE_CONTROL], "no-store");
            }
        }
        assert!(seen.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn malformed_input_never_calls_upstream() {
        let (state, seen) = fixture(None).await;
        for body in [
            "bad",
            "{}",
            r#"{"status":null}"#,
            r#"{"status":"deleted"}"#,
            r#"{"status":"Reviewed"}"#,
            r#"{"status":"spam","p_website_id":"other"}"#,
        ] {
            let (status, headers, _) = send(
                router(state.clone()),
                Method::PATCH,
                &path(SITE, true),
                Some(OWNER),
                true,
                body,
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        }
        for (method, status_path, body) in operations() {
            for bad_path in [
                path("bad", status_path),
                path(SITE, status_path).replace(FORM, "bad"),
                path(SITE, status_path).replace(ROW, "bad"),
            ] {
                let (status, _, _) = send(
                    router(state.clone()),
                    method.clone(),
                    &bad_path,
                    Some(OWNER),
                    true,
                    body,
                )
                .await;
                assert_eq!(status, StatusCode::BAD_REQUEST);
            }
        }
        let (status, _, _) = send(
            router(state),
            Method::DELETE,
            &path(SITE, false),
            Some(OWNER),
            true,
            "{}",
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(seen.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn exact_typed_rpcs_forward_caller_and_project_success() {
        let (state, seen) = fixture(None).await;
        for status_name in ["new", "reviewed", "spam"] {
            let (status, headers, value) = send(
                router(state.clone()),
                Method::PATCH,
                &path(SITE, true),
                Some(OWNER),
                true,
                &json!({"status": status_name}).to_string(),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(headers[header::CACHE_CONTROL], "no-store");
            assert_eq!(value, json!({"id":ROW, "status":status_name}));
        }
        let (status, _, value) = send(
            router(state),
            Method::DELETE,
            &path(SITE, false),
            Some(OWNER),
            true,
            "",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value, json!({"id":ROW,"deleted":true}));
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 4);
        for (index, (rpc, headers, params)) in seen.iter().enumerate() {
            assert_eq!(headers[header::AUTHORIZATION], "Bearer synthetic-owner");
            assert_eq!(headers["apikey"], "synthetic-publishable");
            let mut expected = json!({"p_website_id":SITE,"p_form_id":FORM,"p_response_id":ROW});
            if index < 3 {
                assert_eq!(rpc, "set_website_form_response_status");
                expected["p_status"] = json!(["new", "reviewed", "spam"][index]);
            } else {
                assert_eq!(rpc, "delete_website_form_response");
            }
            assert_eq!(params, &expected);
        }
    }
    #[tokio::test]
    async fn definite_db_refusals_and_sending_lock_are_sanitized() {
        for (upstream, body, expected) in [
            (
                StatusCode::UNAUTHORIZED,
                r#"{"message":"private JWT"}"#,
                UNAUTHORIZED,
            ),
            (
                StatusCode::FORBIDDEN,
                r#"{"code":"42501","message":"private owner gate"}"#,
                NOT_FOUND,
            ),
            (StatusCode::NOT_FOUND, "private", NOT_FOUND),
            (
                StatusCode::BAD_REQUEST,
                r#"{"code":"22023","message":"private status"}"#,
                INVALID,
            ),
        ] {
            for (method, status_path, request_body) in operations() {
                let (state, seen) = fixture(Some((upstream, body.to_owned()))).await;
                let (status, headers, value) = send(
                    router(state),
                    method,
                    &path(SITE, status_path),
                    Some(OWNER),
                    true,
                    request_body,
                )
                .await;
                assert_eq!(status, expected.0);
                assert_eq!(value["code"], expected.1);
                assert_eq!(headers[header::CACHE_CONTROL], "no-store");
                assert!(!value.to_string().contains("private"));
                assert_eq!(seen.lock().unwrap().len(), 1);
            }
        }
        let (state, seen) = fixture(Some((
            StatusCode::INTERNAL_SERVER_ERROR,
            r#"{"code":"55000","message":"private sending"}"#.to_owned(),
        )))
        .await;
        let (status, _, value) = send(
            router(state),
            Method::DELETE,
            &path(SITE, false),
            Some(OWNER),
            true,
            "",
        )
        .await;
        assert_eq!(status, BUSY.0);
        assert_eq!(value["code"], BUSY.1);
        assert_eq!(seen.lock().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn ambiguous_results_are_never_retried_or_reported_as_success() {
        for (upstream, body) in [
            (StatusCode::OK, "bad json"),
            (StatusCode::OK, "false"),
            (StatusCode::OK, "{}"),
            (StatusCode::OK, "[]"),
            (StatusCode::CREATED, "true"),
            (StatusCode::NO_CONTENT, ""),
            (StatusCode::TEMPORARY_REDIRECT, "true"),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                r#"{"message":"private"}"#,
            ),
            (StatusCode::BAD_REQUEST, "{}"),
            (StatusCode::TOO_MANY_REQUESTS, "{}"),
        ] {
            for (method, status_path, request_body) in operations() {
                let (state, seen) = fixture(Some((upstream, body.to_owned()))).await;
                let (status, headers, value) = send(
                    router(state),
                    method,
                    &path(SITE, status_path),
                    Some(OWNER),
                    true,
                    request_body,
                )
                .await;
                assert_eq!(
                    status,
                    StatusCode::SERVICE_UNAVAILABLE,
                    "{upstream}: {body}"
                );
                assert_eq!(headers[header::CACHE_CONTROL], "no-store");
                assert!(value["code"].as_str().unwrap().ends_with("unknown_outcome"));
                assert!(value["error"].as_str().unwrap().contains("not retried"));
                assert!(!value.to_string().contains("private"));
                assert_eq!(seen.lock().unwrap().len(), 1);
            }
        }
    }
    #[tokio::test]
    async fn wrong_success_affinity_and_status_are_ambiguous() {
        for key in ["id", "website_id", "form_id", "status"] {
            let mut row = json!({"id":ROW,"website_id":SITE,"form_id":FORM,"status":"reviewed"});
            row[key] = json!(OTHER);
            let (state, _) = fixture(Some((StatusCode::OK, row.to_string()))).await;
            let (status, _, value) = send(
                router(state),
                Method::PATCH,
                &path(SITE, true),
                Some(OWNER),
                true,
                r#"{"status":"reviewed"}"#,
            )
            .await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(value["code"], "response_status_unknown_outcome");
        }
    }
    #[tokio::test]
    async fn transport_failure_is_ambiguous() {
        // Keep an unserved local port reserved, then close it to force connection refusal.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let state = ResponseState {
            writer: ResponseWriter::new(&origin, "synthetic"),
            enabled: true,
            pilot: Some(pilot()),
        };
        for (method, status_path, body) in operations() {
            let (status, _, value) = send(
                router(state.clone()),
                method,
                &path(SITE, status_path),
                Some(OWNER),
                true,
                body,
            )
            .await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
            assert!(!value.to_string().contains("127.0.0.1"));
        }
    }
    #[tokio::test]
    async fn timeout_redirect_and_broken_body_are_ambiguous_without_retry() {
        for mode in ["timeout", "redirect", "broken-body"] {
            let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let app = Router::new().fallback({
                let hits = hits.clone();
                let origin = origin.clone();
                move || {
                    let hits = hits.clone();
                    let origin = origin.clone();
                    async move {
                        hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        match mode {
                            "timeout" => {
                                tokio::time::sleep(Duration::from_secs(11)).await;
                                Json(json!(true)).into_response()
                            }
                            "redirect" => (
                                StatusCode::TEMPORARY_REDIRECT,
                                [(header::LOCATION, format!("{origin}/destination"))],
                            )
                                .into_response(),
                            _ => {
                                let stream = futures_util::stream::iter([
                                    Ok::<_, std::io::Error>("{"),
                                    Err(std::io::Error::other("synthetic truncated body")),
                                ]);
                                Response::new(Body::from_stream(stream))
                            }
                        }
                    }
                }
            });
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let state = ResponseState {
                writer: ResponseWriter::new(&origin, "synthetic"),
                enabled: true,
                pilot: Some(pilot()),
            };
            for (method, status_path, body) in operations() {
                let (status, headers, value) = send(
                    router(state.clone()),
                    method,
                    &path(SITE, status_path),
                    Some(OWNER),
                    true,
                    body,
                )
                .await;
                assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{mode}");
                assert_eq!(headers[header::CACHE_CONTROL], "no-store");
                assert!(value["code"].as_str().unwrap().ends_with("unknown_outcome"));
            }
            assert_eq!(
                hits.load(std::sync::atomic::Ordering::SeqCst),
                2,
                "{mode}: each explicit request sent exactly once"
            );
            server.abort();
        }
    }

    #[tokio::test]
    async fn exact_cors_and_existing_inbox_route_coexist() {
        let (state, seen) = fixture(None).await;
        let cors = crate::dashboard_cors::DashboardCors::parse_origin("https://dashboard.example")
            .unwrap();
        let app = router(state)
            .merge(crate::form_inbox::router(
                crate::form_inbox::FormInboxState {
                    reader: crate::form_inbox::FormInboxReader::new(
                        "http://127.0.0.1:1",
                        "synthetic",
                    ),
                    enabled: false,
                    pilot: Some(pilot()),
                },
            ))
            .layer(middleware::from_fn_with_state(
                cors,
                crate::dashboard_cors::layer,
            ));
        for (method, status_path, body) in operations() {
            let (status, headers, _) = send(
                app.clone(),
                method,
                &path(SITE, status_path),
                Some(OWNER),
                true,
                body,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(
                headers[header::ACCESS_CONTROL_ALLOW_ORIGIN],
                "https://dashboard.example"
            );
            assert!(!headers.contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS));
        }
        let (status, _, _) = send(
            app.clone(),
            Method::GET,
            &path(SITE, false),
            Some(OWNER),
            true,
            "",
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND); // Existing read gate still off.
        for status_path in [false, true] {
            for (origin, method, suffix, allowed) in [
                (
                    "https://dashboard.example",
                    if status_path { "PATCH" } else { "DELETE" },
                    "",
                    true,
                ),
                ("https://other.example", "DELETE", "", false),
                ("https://dashboard.example", "POST", "", false),
                ("https://dashboard.example", "DELETE", "/retry", false),
            ] {
                let response = app
                    .clone()
                    .oneshot(
                        Request::builder()
                            .method(Method::OPTIONS)
                            .uri(format!("{}{suffix}", path(SITE, status_path)))
                            .header(header::ORIGIN, origin)
                            .header(header::ACCESS_CONTROL_REQUEST_METHOD, method)
                            .header(
                                header::ACCESS_CONTROL_REQUEST_HEADERS,
                                "authorization, content-type",
                            )
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(
                    response
                        .headers()
                        .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN),
                    allowed
                );
                if allowed {
                    assert_eq!(response.status(), StatusCode::NO_CONTENT);
                }
            }
        }
        assert_eq!(seen.lock().unwrap().len(), 2);
    }
}

#[cfg(test)]
mod auth_tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Method, Request},
        middleware,
        routing::get,
    };
    use jsonwebtoken::{Algorithm, EncodingKey, Header, encode, get_current_timestamp};
    use tower::ServiceExt as _;

    // Public synthetic signing fixture, identical to tests/auth.rs; no deployed identity.
    const KEY: &[u8] = b"-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgN259EDuuvQKvS3P1
X5TDF13Yw5yO5mxV69l/tGjWhV+hRANCAASZpPOvquuppgZnbUulhsGfVZYg3hNj
aKpDb+KKizP4pOlKiw3Ov4v43RK43imyuQMfaETyK/spnMZg78WYdE5w
-----END PRIVATE KEY-----";

    #[tokio::test]
    async fn real_verifier_requires_signed_nonanonymous_pilot_owner() {
        let jwks = Router::new().route("/auth/v1/.well-known/jwks.json", get(async || Json(json!({"keys":[{"alg":"ES256","kty":"EC","crv":"P-256","use":"sig","key_ops":["verify"],"kid":"test-key","x":"maTzr6rrqaYGZ21LpYbBn1WWIN4TY2iqQ2_iiosz-KQ","y":"6UqLDc6_i_jdErjeKbK5Ax9oRPIr-ymcxmDvxZh0TnA"}]}))));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, jwks).await.unwrap() });
        let pilot = PilotScope {
            website_id: Uuid::from_u128(1),
            owner_id: Uuid::from_u128(2),
        };
        let app = router(ResponseState {
            writer: ResponseWriter::new("http://127.0.0.1:1", "synthetic"),
            enabled: true,
            pilot: Some(pilot),
        })
        .layer(middleware::from_fn_with_state(
            crate::auth::SupabaseAuth::new(&origin),
            crate::auth::require_user,
        ));
        for method in [Method::PATCH, Method::DELETE] {
            for (owner, anonymous, expired, expected) in [
                (
                    pilot.owner_id,
                    false,
                    false,
                    StatusCode::SERVICE_UNAVAILABLE,
                ), // Valid caller reaches synthetic transport failure.
                (Uuid::from_u128(9), false, false, StatusCode::NOT_FOUND),
                (pilot.owner_id, true, false, StatusCode::UNAUTHORIZED),
                (pilot.owner_id, false, true, StatusCode::UNAUTHORIZED),
            ] {
                let mut header = Header::new(Algorithm::ES256);
                header.kid = Some("test-key".to_owned());
                let token = encode(&header,&json!({"iss":format!("{origin}/auth/v1"),"aud":"authenticated","sub":owner,"role":"authenticated","is_anonymous":anonymous,"exp":if expired {get_current_timestamp()-60} else {get_current_timestamp()+3600}}),&EncodingKey::from_ec_pem(KEY).unwrap()).unwrap();
                let uri = format!(
                    "/websites/{}/forms/{}/responses/{}{}",
                    pilot.website_id,
                    Uuid::from_u128(3),
                    Uuid::from_u128(4),
                    if method == Method::PATCH {
                        "/status"
                    } else {
                        ""
                    }
                );
                let response = app
                    .clone()
                    .oneshot(
                        Request::builder()
                            .method(method.clone())
                            .uri(uri)
                            .header(header::AUTHORIZATION, format!("Bearer {token}"))
                            .header(header::CONTENT_TYPE, "application/json")
                            .body(Body::from(if method == Method::PATCH {
                                r#"{"status":"spam"}"#
                            } else {
                                ""
                            }))
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(response.status(), expected);
                assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            }
        }
        server.abort();
    }
}
