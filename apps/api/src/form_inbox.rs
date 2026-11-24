//! Owner-scoped, read-only Forms list and inbox response list/detail.
//!
//! Every read runs as the caller: the caller's Supabase bearer is forwarded with
//! the publishable key to `PostgREST`, so the owner read policies on
//! `website_forms` and `website_form_responses` decide what is visible. No
//! privileged key is used. The feature is default-off and fails closed.
//!
//! Pilot affinity is enforced here too, not only in the dashboard. The API
//! serves a single website and owner, named by `HTP_FORMS_PILOT_WEBSITE_ID` and
//! `HTP_FORMS_PILOT_OWNER_ID`, the same pair the dashboard checks through
//! `formsPilotWebsiteId` and `formsPilotOwnerId`. Any other website, or any
//! other caller, gets the same not-found as a missing row, before any upstream
//! call. A missing or malformed pilot pair disables the routes.
//!
//! Projections and caps match the dashboard reads in
//! `apps/web/app/components/WebsiteForms.vue`: forms and responses only, with
//! offset paging capped at 100 rows. Recipient and delivery-job tables are not
//! read here, which keeps the pilot condition (no notification state) intact.

use axum::{
    Extension, Json, Router,
    extract::{
        Path, Query, State,
        rejection::{PathRejection, QueryRejection},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};
use std::time::Duration;
use uuid::Uuid;

use crate::auth::AuthenticatedUser;

/// Environment flag. Only the exact value `true` enables the routes.
pub(crate) const ENABLE_VAR: &str = "HTP_FORMS_OWNER_INBOX_API";
/// Pilot website that the inbox API serves.
pub(crate) const PILOT_WEBSITE_VAR: &str = "HTP_FORMS_PILOT_WEBSITE_ID";
/// Pilot owner, the only caller the inbox API serves.
pub(crate) const PILOT_OWNER_VAR: &str = "HTP_FORMS_PILOT_OWNER_ID";

pub(crate) fn enabled_from_env() -> bool {
    std::env::var(ENABLE_VAR).as_deref() == Ok("true")
}

pub(crate) fn pilot_from_env() -> Option<PilotScope> {
    parse_pilot(
        std::env::var(PILOT_WEBSITE_VAR).ok().as_deref(),
        std::env::var(PILOT_OWNER_VAR).ok().as_deref(),
    )
}

/// Both values must be present and parse as UUIDs, or there is no pilot scope.
fn parse_pilot(website: Option<&str>, owner: Option<&str>) -> Option<PilotScope> {
    Some(PilotScope {
        website_id: Uuid::parse_str(website?).ok()?,
        owner_id: Uuid::parse_str(owner?).ok()?,
    })
}

/// The one website and owner this API serves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PilotScope {
    pub website_id: Uuid,
    pub owner_id: Uuid,
}

const FORM_COLUMNS: &str = "id,form_key,name,fields,active";
const RESPONSE_COLUMNS: &str = "id,received_at,status,values";
const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 100;

/// Stable, non-sensitive failure. Messages are fixed text, never upstream detail.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct InboxError {
    pub code: &'static str,
    pub message: &'static str,
    pub status: StatusCode,
}

const NOT_ENABLED: InboxError = InboxError {
    code: "forms_inbox_disabled",
    message: "Forms inbox API is not enabled on this server.",
    status: StatusCode::NOT_FOUND,
};
const NOT_FOUND: InboxError = InboxError {
    code: "not_found",
    message: "Not found or inaccessible.",
    status: StatusCode::NOT_FOUND,
};
const UNAUTHORIZED: InboxError = InboxError {
    code: "unauthorized",
    message: "Sign in again.",
    status: StatusCode::UNAUTHORIZED,
};
const INVALID: InboxError = InboxError {
    code: "invalid_request",
    message: "Invalid request. Limit must be 1 to 100 and ids must be UUIDs.",
    status: StatusCode::BAD_REQUEST,
};
const UNAVAILABLE: InboxError = InboxError {
    code: "inbox_unavailable",
    message: "The Forms inbox is temporarily unavailable. Retry later.",
    status: StatusCode::SERVICE_UNAVAILABLE,
};

/// Read-only client for the two owner-readable Forms tables.
#[derive(Clone)]
pub(crate) struct FormInboxReader {
    project_url: String,
    publishable_key: String,
    client: reqwest::Client,
}

impl FormInboxReader {
    pub(crate) fn new(project_url: &str, publishable_key: &str) -> Self {
        Self {
            project_url: project_url.trim_end_matches('/').to_owned(),
            publishable_key: publishable_key.to_owned(),
            // Redirects are disabled so the bearer is never sent to another origin.
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("static reqwest client configuration"),
        }
    }

    /// GET the rows for one table with the caller's bearer. Returns the parsed
    /// array. Upstream bodies are never copied into errors.
    async fn get_rows(
        &self,
        headers: &HeaderMap,
        table: &str,
        query: &[(&str, String)],
    ) -> Result<Vec<Value>, InboxError> {
        let authorization = headers.get(header::AUTHORIZATION).ok_or(UNAUTHORIZED)?;
        let response = self
            .client
            .get(format!("{}/rest/v1/{table}", self.project_url))
            .header("apikey", &self.publishable_key)
            .header(header::AUTHORIZATION, authorization)
            .timeout(Duration::from_secs(10))
            .query(query)
            .send()
            .await
            .map_err(|_| UNAVAILABLE)?;
        match response.status() {
            s if s.is_success() => {}
            reqwest::StatusCode::UNAUTHORIZED => return Err(UNAUTHORIZED),
            // Owner RLS hides foreign or unapproved rows as empty results; a
            // 403/404 from the API is reported as not found, never as detail.
            reqwest::StatusCode::FORBIDDEN | reqwest::StatusCode::NOT_FOUND => {
                return Err(NOT_FOUND);
            }
            _ => return Err(UNAVAILABLE),
        }
        let value: Value = response.json().await.map_err(|_| UNAVAILABLE)?;
        match value {
            Value::Array(rows) => Ok(rows),
            _ => Err(UNAVAILABLE),
        }
    }

    /// One page of forms for a website. Fetches one extra row to report `has_more`.
    pub(crate) async fn list_forms(
        &self,
        headers: &HeaderMap,
        website_id: Uuid,
        page: Page,
    ) -> Result<Value, InboxError> {
        let mut rows = self
            .get_rows(
                headers,
                "website_forms",
                &[
                    ("select", FORM_COLUMNS.to_owned()),
                    ("website_id", format!("eq.{website_id}")),
                    ("order", "name.asc,id.asc".to_owned()),
                    ("limit", (page.limit + 1).to_string()),
                    ("offset", page.offset.to_string()),
                ],
            )
            .await?;
        let has_more = rows.len() > page.limit;
        rows.truncate(page.limit);
        Ok(json!({"items": rows, "has_more": has_more}))
    }

    /// One page of inbox responses for one form, newest first. The order matches
    /// the dashboard's `received_at desc, id` inbox index.
    pub(crate) async fn list_responses(
        &self,
        headers: &HeaderMap,
        website_id: Uuid,
        form_id: Uuid,
        page: Page,
    ) -> Result<Value, InboxError> {
        let mut rows = self
            .get_rows(
                headers,
                "website_form_responses",
                &[
                    ("select", RESPONSE_COLUMNS.to_owned()),
                    ("website_id", format!("eq.{website_id}")),
                    ("form_id", format!("eq.{form_id}")),
                    ("order", "received_at.desc,id.asc".to_owned()),
                    ("limit", (page.limit + 1).to_string()),
                    ("offset", page.offset.to_string()),
                ],
            )
            .await?;
        let has_more = rows.len() > page.limit;
        rows.truncate(page.limit);
        Ok(json!({"items": rows, "has_more": has_more}))
    }

    /// One response, scoped to its website and form. Zero rows is not found.
    pub(crate) async fn response_detail(
        &self,
        headers: &HeaderMap,
        website_id: Uuid,
        form_id: Uuid,
        response_id: Uuid,
    ) -> Result<Value, InboxError> {
        let mut rows = self
            .get_rows(
                headers,
                "website_form_responses",
                &[
                    ("select", RESPONSE_COLUMNS.to_owned()),
                    ("id", format!("eq.{response_id}")),
                    ("website_id", format!("eq.{website_id}")),
                    ("form_id", format!("eq.{form_id}")),
                    ("limit", "1".to_owned()),
                ],
            )
            .await?;
        if rows.len() != 1 {
            return Err(NOT_FOUND);
        }
        Ok(rows.remove(0))
    }
}

/// Validated paging for one list request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Page {
    pub limit: usize,
    pub offset: usize,
}

impl Page {
    pub(crate) fn parse(limit: Option<usize>, offset: Option<usize>) -> Result<Self, InboxError> {
        let limit = limit.unwrap_or(DEFAULT_LIMIT);
        if !(1..=MAX_LIMIT).contains(&limit) {
            return Err(INVALID);
        }
        Ok(Self {
            limit,
            offset: offset.unwrap_or(0),
        })
    }
}

#[derive(Clone)]
pub(crate) struct FormInboxState {
    pub(crate) reader: FormInboxReader,
    pub(crate) enabled: bool,
    pub(crate) pilot: Option<PilotScope>,
}

#[derive(serde::Deserialize)]
struct PageQuery {
    limit: Option<usize>,
    offset: Option<usize>,
}

/// Authenticated read-only routes, merged behind `auth::require_user`:
///   GET `/websites/{id}/forms`
///   GET `/websites/{id}/forms/{form_id}/responses`
///   GET `/websites/{id}/forms/{form_id}/responses/{response_id}`
///
/// Path and query extraction is wrapped in `Result`, so malformed input reaches
/// the handler and gets the same JSON envelope and `no-store` as every other
/// response, rather than axum's plain-text rejection.
pub(crate) fn router(state: FormInboxState) -> Router {
    Router::new()
        .route("/websites/{id}/forms", get(list_forms))
        .route(
            "/websites/{id}/forms/{form_id}/responses",
            get(list_responses),
        )
        .route(
            "/websites/{id}/forms/{form_id}/responses/{response_id}",
            get(response_detail),
        )
        .with_state(state)
}

type Caller = Option<Extension<AuthenticatedUser>>;

async fn list_forms(
    State(state): State<FormInboxState>,
    caller: Caller,
    headers: HeaderMap,
    path: Result<Path<Uuid>, PathRejection>,
    query: Result<Query<PageQuery>, QueryRejection>,
) -> Response {
    let result = async {
        ensure_enabled(&state)?;
        let website_id = path_or_invalid(path)?;
        let page = page_or_invalid(query)?;
        authorize(&state, caller.as_ref(), website_id)?;
        state.reader.list_forms(&headers, website_id, page).await
    }
    .await;
    respond(result)
}

async fn list_responses(
    State(state): State<FormInboxState>,
    caller: Caller,
    headers: HeaderMap,
    path: Result<Path<(Uuid, Uuid)>, PathRejection>,
    query: Result<Query<PageQuery>, QueryRejection>,
) -> Response {
    let result = async {
        ensure_enabled(&state)?;
        let (website_id, form_id) = path_or_invalid(path)?;
        let page = page_or_invalid(query)?;
        authorize(&state, caller.as_ref(), website_id)?;
        state
            .reader
            .list_responses(&headers, website_id, form_id, page)
            .await
    }
    .await;
    respond(result)
}

async fn response_detail(
    State(state): State<FormInboxState>,
    caller: Caller,
    headers: HeaderMap,
    path: Result<Path<(Uuid, Uuid, Uuid)>, PathRejection>,
) -> Response {
    let result = async {
        ensure_enabled(&state)?;
        let (website_id, form_id, response_id) = path_or_invalid(path)?;
        authorize(&state, caller.as_ref(), website_id)?;
        state
            .reader
            .response_detail(&headers, website_id, form_id, response_id)
            .await
    }
    .await;
    respond(result)
}

fn path_or_invalid<T>(path: Result<Path<T>, PathRejection>) -> Result<T, InboxError> {
    path.map(|Path(value)| value).map_err(|_| INVALID)
}

fn page_or_invalid(query: Result<Query<PageQuery>, QueryRejection>) -> Result<Page, InboxError> {
    let Query(query) = query.map_err(|_| INVALID)?;
    Page::parse(query.limit, query.offset)
}

fn ensure_enabled(state: &FormInboxState) -> Result<(), InboxError> {
    if state.enabled && state.pilot.is_some() {
        Ok(())
    } else {
        Err(NOT_ENABLED)
    }
}

/// Enablement, then pilot affinity. Any website other than the pilot website, or
/// any caller other than the pilot owner, gets the same not-found as a missing
/// row, before any upstream call. The check is server-side and needs no key.
fn authorize(
    state: &FormInboxState,
    caller: Option<&Extension<AuthenticatedUser>>,
    website_id: Uuid,
) -> Result<(), InboxError> {
    ensure_enabled(state)?;
    let caller = caller.ok_or(UNAUTHORIZED)?;
    let pilot = state.pilot.ok_or(NOT_ENABLED)?;
    if website_id == pilot.website_id && caller.0.id == pilot.owner_id {
        Ok(())
    } else {
        Err(NOT_FOUND)
    }
}

/// Every response is no-store: inbox rows contain submitted personal data.
fn respond(result: Result<Value, InboxError>) -> Response {
    let (status, body) = match result {
        Ok(value) => (StatusCode::OK, value),
        Err(error) => (
            error.status,
            json!({"code": error.code, "error": error.message}),
        ),
    };
    (status, [(header::CACHE_CONTROL, "no-store")], Json(body)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router, body::Body, extract::Query as AxQuery, http::Request, routing::get as axget,
    };
    use std::{
        collections::HashMap,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };
    use tower::ServiceExt as _;

    const SITE: &str = "00000000-0000-0000-0000-000000000001";
    const FORM: &str = "00000000-0000-0000-0000-000000000002";
    const RESPONSE: &str = "00000000-0000-0000-0000-000000000003";
    const OWNER: &str = "00000000-0000-0000-0000-0000000000aa";
    const OTHER_SITE: &str = "00000000-0000-0000-0000-0000000000bb";
    const OTHER_OWNER: &str = "00000000-0000-0000-0000-0000000000cc";
    const MISSING: &str = "00000000-0000-0000-0000-0000000000dd";

    fn bearer() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer owner-token".parse().unwrap());
        headers
    }

    fn uuid(value: &str) -> Uuid {
        Uuid::parse_str(value).unwrap()
    }

    fn pilot() -> PilotScope {
        PilotScope {
            website_id: uuid(SITE),
            owner_id: uuid(OWNER),
        }
    }

    struct Fixture {
        reader: FormInboxReader,
        /// Count of upstream requests. Tests use it to prove no upstream call happened.
        hits: Arc<AtomicUsize>,
    }

    /// A local fixture `PostgREST`. It only answers when the caller's bearer and
    /// publishable key are forwarded, and echoes the query it received so tests
    /// can check the exact projection, filters, ordering and limit. It returns no
    /// rows for the `MISSING` response id.
    async fn fixture() -> Fixture {
        async fn echo(
            State(hits): State<Arc<AtomicUsize>>,
            headers: HeaderMap,
            AxQuery(query): AxQuery<HashMap<String, String>>,
        ) -> Response {
            hits.fetch_add(1, Ordering::SeqCst);
            if headers.get("authorization").and_then(|v| v.to_str().ok())
                != Some("Bearer owner-token")
                || headers.get("apikey").and_then(|v| v.to_str().ok()) != Some("test-publishable")
            {
                return (StatusCode::UNAUTHORIZED, "{}").into_response();
            }
            if query.get("id").map(String::as_str) == Some(&format!("eq.{MISSING}")) {
                return Json(Value::Array(Vec::new())).into_response();
            }
            let limit: usize = query.get("limit").and_then(|v| v.parse().ok()).unwrap_or(0);
            let rows: Vec<Value> = (0..limit.min(3))
                .map(|i| json!({"id": i, "select": query.get("select")}))
                .collect();
            Json(Value::Array(rows)).into_response()
        }
        let hits = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route("/rest/v1/website_forms", axget(echo))
            .route("/rest/v1/website_form_responses", axget(echo))
            .with_state(hits.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Fixture {
            reader: FormInboxReader::new(&origin, "test-publishable"),
            hits,
        }
    }

    fn app(enabled: bool, pilot: Option<PilotScope>, reader: FormInboxReader) -> Router {
        router(FormInboxState {
            reader,
            enabled,
            pilot,
        })
    }

    /// Sends one request through the router as the given caller. The caller is
    /// injected the way `auth::require_user` would, so handlers see a verified user.
    async fn send(app: Router, uri: &str, caller: Option<&str>) -> (StatusCode, HeaderMap, Value) {
        let mut request = Request::builder()
            .uri(uri)
            .header("authorization", "Bearer owner-token")
            .body(Body::empty())
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

    #[test]
    fn page_is_capped_and_defaults_are_bounded() {
        assert_eq!(Page::parse(None, None).unwrap().limit, DEFAULT_LIMIT);
        assert_eq!(Page::parse(Some(100), Some(200)).unwrap().offset, 200);
        assert_eq!(Page::parse(Some(0), None), Err(INVALID));
        assert_eq!(Page::parse(Some(101), None), Err(INVALID));
    }

    #[test]
    fn disabled_is_not_found_and_checked_first() {
        let state = FormInboxState {
            reader: FormInboxReader::new("http://127.0.0.1:1", "test-publishable"),
            enabled: false,
            pilot: Some(pilot()),
        };
        assert_eq!(ensure_enabled(&state), Err(NOT_ENABLED));
        assert_eq!(NOT_ENABLED.status, StatusCode::NOT_FOUND);
    }

    #[test]
    fn pilot_pair_must_be_complete_and_valid() {
        assert_eq!(parse_pilot(None, Some(OWNER)), None);
        assert_eq!(parse_pilot(Some(SITE), None), None);
        assert_eq!(parse_pilot(Some("not-a-uuid"), Some(OWNER)), None);
        assert_eq!(
            parse_pilot(Some(SITE), Some(OWNER)),
            Some(PilotScope {
                website_id: uuid(SITE),
                owner_id: uuid(OWNER),
            })
        );
    }

    #[test]
    fn missing_pilot_fails_closed_even_when_enabled() {
        let state = FormInboxState {
            reader: FormInboxReader::new("http://127.0.0.1:1", "test-publishable"),
            enabled: true,
            pilot: None,
        };
        assert_eq!(ensure_enabled(&state), Err(NOT_ENABLED));
    }

    #[tokio::test]
    async fn list_forms_uses_dashboard_projection_and_reports_has_more() {
        let fixture = fixture().await;
        // Limit 2 asks upstream for 3 rows; three rows returned means has_more.
        let page = Page {
            limit: 2,
            offset: 0,
        };
        let value = fixture
            .reader
            .list_forms(&bearer(), uuid(SITE), page)
            .await
            .unwrap();
        assert_eq!(value["has_more"], json!(true));
        assert_eq!(value["items"].as_array().unwrap().len(), 2);
        assert_eq!(value["items"][0]["select"], json!(FORM_COLUMNS));
    }

    #[tokio::test]
    async fn list_responses_is_paged_without_recipient_or_job_reads() {
        let fixture = fixture().await;
        let page = Page {
            limit: 5,
            offset: 0,
        };
        let value = fixture
            .reader
            .list_responses(&bearer(), uuid(SITE), uuid(FORM), page)
            .await
            .unwrap();
        assert_eq!(value["has_more"], json!(false));
        assert_eq!(value["items"][0]["select"], json!(RESPONSE_COLUMNS));
        assert!(!RESPONSE_COLUMNS.contains("recipient"));
        assert!(!RESPONSE_COLUMNS.contains("delivery"));
    }

    #[tokio::test]
    async fn missing_bearer_fails_before_upstream() {
        // Unreachable origin: a transport call would surface as unavailable.
        let reader = FormInboxReader::new("http://127.0.0.1:1", "test-publishable");
        let page = Page {
            limit: 1,
            offset: 0,
        };
        assert_eq!(
            reader.list_forms(&HeaderMap::new(), uuid(SITE), page).await,
            Err(UNAUTHORIZED)
        );
    }

    #[tokio::test]
    async fn upstream_auth_failure_maps_to_fixed_code() {
        let fixture = fixture().await;
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer wrong".parse().unwrap());
        let page = Page {
            limit: 1,
            offset: 0,
        };
        assert_eq!(
            fixture.reader.list_forms(&headers, uuid(SITE), page).await,
            Err(UNAUTHORIZED)
        );
    }

    #[tokio::test]
    async fn unreachable_upstream_is_unavailable_without_detail() {
        let reader = FormInboxReader::new("http://127.0.0.1:1", "test-publishable");
        let page = Page {
            limit: 1,
            offset: 0,
        };
        let error = reader
            .list_responses(&bearer(), uuid(SITE), uuid(FORM), page)
            .await
            .unwrap_err();
        assert_eq!(error, UNAVAILABLE);
        assert!(!error.message.contains("127.0.0.1"));
    }

    #[tokio::test]
    async fn every_response_is_no_store() {
        let response = respond(Err(NOT_ENABLED));
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn disabled_malformed_requests_are_404_no_store_and_never_upstream() {
        let fixture = fixture().await;
        let app = app(false, Some(pilot()), fixture.reader.clone());
        for uri in [
            "/websites/not-a-uuid/forms".to_owned(),
            format!("/websites/{SITE}/forms?limit=abc"),
            format!("/websites/{SITE}/forms?limit=-1"),
        ] {
            let (status, headers, body) = send(app.clone(), &uri, Some(OWNER)).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
            assert_eq!(headers[header::CACHE_CONTROL], "no-store", "{uri}");
            assert_eq!(body["code"], json!("forms_inbox_disabled"), "{uri}");
        }
        assert_eq!(fixture.hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn enabled_malformed_requests_use_invalid_envelope_with_no_store() {
        let fixture = fixture().await;
        let app = app(true, Some(pilot()), fixture.reader.clone());
        for uri in [
            "/websites/not-a-uuid/forms".to_owned(),
            format!("/websites/{SITE}/forms?limit=abc"),
            format!("/websites/{SITE}/forms?limit=-1"),
            format!("/websites/{SITE}/forms/not-a-uuid/responses"),
        ] {
            let (status, headers, body) = send(app.clone(), &uri, Some(OWNER)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}");
            assert_eq!(headers[header::CACHE_CONTROL], "no-store", "{uri}");
            assert_eq!(body["code"], json!("invalid_request"), "{uri}");
        }
        assert_eq!(fixture.hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn non_pilot_website_is_not_found_without_upstream() {
        let fixture = fixture().await;
        let app = app(true, Some(pilot()), fixture.reader.clone());
        let uris = [
            format!("/websites/{OTHER_SITE}/forms"),
            format!("/websites/{OTHER_SITE}/forms/{FORM}/responses"),
            format!("/websites/{OTHER_SITE}/forms/{FORM}/responses/{RESPONSE}"),
        ];
        for uri in uris {
            let (status, headers, body) = send(app.clone(), &uri, Some(OWNER)).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
            assert_eq!(headers[header::CACHE_CONTROL], "no-store", "{uri}");
            assert_eq!(body["code"], json!("not_found"), "{uri}");
        }
        assert_eq!(fixture.hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn non_pilot_owner_is_not_found_without_upstream() {
        let fixture = fixture().await;
        let app = app(true, Some(pilot()), fixture.reader.clone());
        let (status, _, body) =
            send(app, &format!("/websites/{SITE}/forms"), Some(OTHER_OWNER)).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["code"], json!("not_found"));
        assert_eq!(fixture.hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn missing_caller_identity_is_unauthorized_without_upstream() {
        let fixture = fixture().await;
        let app = app(true, Some(pilot()), fixture.reader.clone());
        let (status, headers, body) = send(app, &format!("/websites/{SITE}/forms"), None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert_eq!(body["code"], json!("unauthorized"));
        assert_eq!(fixture.hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn pilot_success_is_no_store_and_reports_has_more() {
        let fixture = fixture().await;
        let app = app(true, Some(pilot()), fixture.reader.clone());
        let (status, headers, body) = send(
            app.clone(),
            &format!("/websites/{SITE}/forms/{FORM}/responses?limit=2"),
            Some(OWNER),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert_eq!(body["has_more"], json!(true));
        assert_eq!(body["items"].as_array().unwrap().len(), 2);
        assert_eq!(fixture.hits.load(Ordering::SeqCst), 1);

        let (status, headers, _) =
            send(app, &format!("/websites/{SITE}/forms?limit=5"), Some(OWNER)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    }

    #[tokio::test]
    async fn zero_row_detail_is_not_found_with_no_store() {
        let fixture = fixture().await;
        let app = app(true, Some(pilot()), fixture.reader.clone());
        let (status, headers, body) = send(
            app,
            &format!("/websites/{SITE}/forms/{FORM}/responses/{MISSING}"),
            Some(OWNER),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert_eq!(body["code"], json!("not_found"));
        assert_eq!(fixture.hits.load(Ordering::SeqCst), 1);
    }
}
