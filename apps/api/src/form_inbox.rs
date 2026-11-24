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
//!
//! Static-build pilot metadata rides the same gate and bearer. It is read-only
//! and bounded: a boolean pilot eligibility answer, host rows projected to
//! `id,hostname,verified_at` (never `challenge_hash`), and origin rows projected
//! to `form_id,host_id`. Eligibility is not a grant; owner RLS still decides.

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
/// Host metadata the dashboard reads. `challenge_hash` is never selected.
const HOST_COLUMNS: &str = "id,hostname,verified_at";
const HOST_KEYS: &[&str] = &["id", "hostname", "verified_at"];
const ORIGIN_COLUMNS: &str = "form_id,host_id";
const ORIGIN_KEYS: &[&str] = &["form_id", "host_id"];
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

impl FormInboxReader {
    /// Whether the caller can see the website through the owner RLS on `websites`.
    /// Zero rows or a not-found from upstream is `false`; other failures propagate.
    pub(crate) async fn owner_can_see_site(
        &self,
        headers: &HeaderMap,
        website_id: Uuid,
    ) -> Result<bool, InboxError> {
        match self
            .get_rows(
                headers,
                "websites",
                &[
                    ("select", "id".to_owned()),
                    ("id", format!("eq.{website_id}")),
                    ("limit", "1".to_owned()),
                ],
            )
            .await
        {
            Ok(rows) => Ok(rows.len() == 1),
            Err(error) if error == NOT_FOUND => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// One page of host metadata for a website, ordered by hostname.
    pub(crate) async fn list_hosts(
        &self,
        headers: &HeaderMap,
        website_id: Uuid,
        page: Page,
    ) -> Result<Value, InboxError> {
        let rows = self
            .get_rows(
                headers,
                "website_form_hosts",
                &[
                    ("select", HOST_COLUMNS.to_owned()),
                    ("website_id", format!("eq.{website_id}")),
                    ("order", "hostname.asc,id.asc".to_owned()),
                    ("limit", (page.limit + 1).to_string()),
                    ("offset", page.offset.to_string()),
                ],
            )
            .await?;
        Ok(bounded_page(rows, page, HOST_KEYS))
    }

    /// One page of form-to-host origin rows for a website, optionally for one form.
    pub(crate) async fn list_origins(
        &self,
        headers: &HeaderMap,
        website_id: Uuid,
        form_id: Option<Uuid>,
        page: Page,
    ) -> Result<Value, InboxError> {
        let mut query = vec![
            ("select", ORIGIN_COLUMNS.to_owned()),
            ("website_id", format!("eq.{website_id}")),
            ("order", "form_id.asc,host_id.asc".to_owned()),
            ("limit", (page.limit + 1).to_string()),
            ("offset", page.offset.to_string()),
        ];
        if let Some(form_id) = form_id {
            query.push(("form_id", format!("eq.{form_id}")));
        }
        let rows = self
            .get_rows(headers, "website_form_origins", &query)
            .await?;
        Ok(bounded_page(rows, page, ORIGIN_KEYS))
    }
}

/// Trims the probe row, sets `has_more`, and keeps only allowlisted keys per row.
fn bounded_page(mut rows: Vec<Value>, page: Page, keys: &[&str]) -> Value {
    let has_more = rows.len() > page.limit;
    rows.truncate(page.limit);
    let items: Vec<Value> = rows.into_iter().map(|row| project(row, keys)).collect();
    json!({"items": items, "has_more": has_more})
}

/// Copies only the allowlisted keys, so extra upstream columns never reach a body.
fn project(row: Value, keys: &[&str]) -> Value {
    let Value::Object(mut map) = row else {
        return json!({});
    };
    let mut out = serde_json::Map::new();
    for key in keys {
        if let Some(value) = map.remove(*key) {
            out.insert((*key).to_owned(), value);
        }
    }
    Value::Object(out)
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

#[derive(serde::Deserialize)]
struct OriginQuery {
    limit: Option<usize>,
    offset: Option<usize>,
    form_id: Option<Uuid>,
}

/// Authenticated read-only routes, merged behind `auth::require_user`:
///   GET `/websites/{id}/forms`
///   GET `/websites/{id}/forms/{form_id}/responses`
///   GET `/websites/{id}/forms/{form_id}/responses/{response_id}`
///   GET `/websites/{id}/forms/pilot-eligibility` (boolean, pilot pair only)
///   GET `/websites/{id}/forms/hosts` (`id`, `hostname`, `verified_at`)
///   GET `/websites/{id}/forms/origins` (`form_id`, `host_id`; optional `form_id` filter)
///
/// Path and query extraction is wrapped in `Result`, so malformed input reaches
/// the handler and gets the same JSON envelope and `no-store` as every other
/// response, rather than axum's plain-text rejection.
pub(crate) fn router(state: FormInboxState) -> Router {
    Router::new()
        .route("/websites/{id}/forms", get(list_forms))
        .route(
            "/websites/{id}/forms/pilot-eligibility",
            get(pilot_eligibility),
        )
        .route("/websites/{id}/forms/hosts", get(list_hosts))
        .route("/websites/{id}/forms/origins", get(list_origins))
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

/// `{"eligible": bool}`. True only for the exact pilot website and owner, and only
/// when owner RLS also shows the site to the caller's bearer. Nothing else leaves.
async fn pilot_eligibility(
    State(state): State<FormInboxState>,
    caller: Caller,
    headers: HeaderMap,
    path: Result<Path<Uuid>, PathRejection>,
) -> Response {
    let result = async {
        ensure_enabled(&state)?;
        let website_id = path_or_invalid(path)?;
        let eligible = pilot_match(&state, caller.as_ref(), website_id)?
            && state
                .reader
                .owner_can_see_site(&headers, website_id)
                .await?;
        Ok(json!({"eligible": eligible}))
    }
    .await;
    respond(result)
}

async fn list_hosts(
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
        state.reader.list_hosts(&headers, website_id, page).await
    }
    .await;
    respond(result)
}

async fn list_origins(
    State(state): State<FormInboxState>,
    caller: Caller,
    headers: HeaderMap,
    path: Result<Path<Uuid>, PathRejection>,
    query: Result<Query<OriginQuery>, QueryRejection>,
) -> Response {
    let result = async {
        ensure_enabled(&state)?;
        let website_id = path_or_invalid(path)?;
        let Query(query) = query.map_err(|_| INVALID)?;
        let page = Page::parse(query.limit, query.offset)?;
        authorize(&state, caller.as_ref(), website_id)?;
        state
            .reader
            .list_origins(&headers, website_id, query.form_id, page)
            .await
    }
    .await;
    respond(result)
}

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

/// Enablement, then the exact pilot pair. `Ok(false)` means the caller or website
/// is not the pilot; it makes no upstream call. A missing caller is unauthorized.
fn pilot_match(
    state: &FormInboxState,
    caller: Option<&Extension<AuthenticatedUser>>,
    website_id: Uuid,
) -> Result<bool, InboxError> {
    ensure_enabled(state)?;
    let caller = caller.ok_or(UNAUTHORIZED)?;
    let pilot = state.pilot.ok_or(NOT_ENABLED)?;
    Ok(website_id == pilot.website_id && caller.0.id == pilot.owner_id)
}

/// Enablement, then pilot affinity. Any website other than the pilot website, or
/// any caller other than the pilot owner, gets the same not-found as a missing
/// row, before any upstream call. The check is server-side and needs no key.
fn authorize(
    state: &FormInboxState,
    caller: Option<&Extension<AuthenticatedUser>>,
    website_id: Uuid,
) -> Result<(), InboxError> {
    if pilot_match(state, caller, website_id)? {
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
            Arc, Mutex,
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

    /// Every upstream request as (table, decoded query), in arrival order.
    type Seen = Arc<Mutex<Vec<(String, HashMap<String, String>)>>>;

    #[derive(Clone)]
    struct Upstream {
        hits: Arc<AtomicUsize>,
        seen: Seen,
    }

    struct Fixture {
        reader: FormInboxReader,
        /// Count of upstream requests. Tests use it to prove no upstream call happened.
        hits: Arc<AtomicUsize>,
        seen: Seen,
    }

    /// Serves one fixture table. Counts and records the request first, then answers
    /// only when the caller's bearer and publishable key are forwarded. Host rows
    /// carry a benign `challenge_hash` placeholder so tests can prove it is dropped.
    fn serve(
        upstream: &Upstream,
        table: &str,
        headers: &HeaderMap,
        query: &HashMap<String, String>,
    ) -> Response {
        upstream.hits.fetch_add(1, Ordering::SeqCst);
        upstream
            .seen
            .lock()
            .unwrap()
            .push((table.to_owned(), query.clone()));
        if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some("Bearer owner-token")
            || headers.get("apikey").and_then(|v| v.to_str().ok()) != Some("test-publishable")
        {
            return (StatusCode::UNAUTHORIZED, "{}").into_response();
        }
        let limit: usize = query.get("limit").and_then(|v| v.parse().ok()).unwrap_or(0);
        let rows: Vec<Value> = match table {
            // Owner RLS shows only the fixture site to its owner; anything else is empty.
            "websites" if query.get("id") == Some(&format!("eq.{SITE}")) => {
                vec![json!({"id": SITE})]
            }
            "websites" => Vec::new(),
            "website_form_hosts" => (0..limit.min(3))
                .map(|i| {
                    json!({
                        "id": i,
                        "hostname": "www.example.test",
                        "verified_at": null,
                        "created_at": "benign-fixture-time",
                        "challenge_hash": "benign-fixture-not-a-hash",
                    })
                })
                .collect(),
            "website_form_origins" => (0..limit.min(3))
                .map(|i| json!({"form_id": FORM, "host_id": i, "website_id": SITE}))
                .collect(),
            _ if query.get("id") == Some(&format!("eq.{MISSING}")) => Vec::new(),
            _ => (0..limit.min(3))
                .map(|i| json!({"id": i, "select": query.get("select")}))
                .collect(),
        };
        Json(Value::Array(rows)).into_response()
    }

    /// A local fixture `PostgREST`, one route per table name.
    async fn fixture() -> Fixture {
        async fn table_echo(
            State(upstream): State<Upstream>,
            axum::extract::Path(table): axum::extract::Path<String>,
            headers: HeaderMap,
            AxQuery(query): AxQuery<HashMap<String, String>>,
        ) -> Response {
            serve(&upstream, &table, &headers, &query)
        }
        let hits = Arc::new(AtomicUsize::new(0));
        let seen: Seen = Arc::new(Mutex::new(Vec::new()));
        let app = Router::new()
            .route("/rest/v1/{table}", axget(table_echo))
            .with_state(Upstream {
                hits: hits.clone(),
                seen: seen.clone(),
            });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Fixture {
            reader: FormInboxReader::new(&origin, "test-publishable"),
            hits,
            seen,
        }
    }

    /// The last upstream request recorded for `table`.
    fn last_query(fixture: &Fixture, table: &str) -> HashMap<String, String> {
        fixture
            .seen
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|(seen, _)| seen == table)
            .map(|(_, query)| query.clone())
            .expect("upstream table was read")
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

    #[test]
    fn project_keeps_only_allowlisted_keys() {
        let row = json!({"id": 1, "hostname": "www.example.test", "challenge_hash": "x"});
        assert_eq!(
            project(row, HOST_KEYS),
            json!({"id": 1, "hostname": "www.example.test"})
        );
        assert_eq!(project(json!("not-an-object"), HOST_KEYS), json!({}));
    }

    #[tokio::test]
    async fn eligibility_is_true_only_for_pilot_pair_visible_to_owner() {
        let fixture = fixture().await;
        let app = app(true, Some(pilot()), fixture.reader.clone());
        let (status, headers, body) = send(
            app,
            &format!("/websites/{SITE}/forms/pilot-eligibility"),
            Some(OWNER),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert_eq!(body, json!({"eligible": true}));
        assert_eq!(fixture.hits.load(Ordering::SeqCst), 1);
        assert_eq!(last_query(&fixture, "websites")["id"], format!("eq.{SITE}"));
    }

    #[tokio::test]
    async fn eligibility_is_false_for_other_site_or_owner_without_upstream() {
        let fixture = fixture().await;
        let app = app(true, Some(pilot()), fixture.reader.clone());
        let cases = [
            (
                format!("/websites/{OTHER_SITE}/forms/pilot-eligibility"),
                OWNER,
            ),
            (
                format!("/websites/{SITE}/forms/pilot-eligibility"),
                OTHER_OWNER,
            ),
        ];
        for (uri, caller) in cases {
            let (status, headers, body) = send(app.clone(), &uri, Some(caller)).await;
            assert_eq!(status, StatusCode::OK, "{uri}");
            assert_eq!(headers[header::CACHE_CONTROL], "no-store", "{uri}");
            assert_eq!(body, json!({"eligible": false}), "{uri}");
        }
        assert_eq!(fixture.hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn eligibility_is_false_when_owner_rls_hides_the_pilot_site() {
        // The pilot names a site the fixture never shows to the caller.
        let fixture = fixture().await;
        let scope = PilotScope {
            website_id: uuid(OTHER_SITE),
            owner_id: uuid(OWNER),
        };
        let app = app(true, Some(scope), fixture.reader.clone());
        let (status, _, body) = send(
            app,
            &format!("/websites/{OTHER_SITE}/forms/pilot-eligibility"),
            Some(OWNER),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"eligible": false}));
        assert_eq!(fixture.hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn eligibility_disabled_is_404_no_store_and_never_upstream() {
        let fixture = fixture().await;
        let app = app(false, Some(pilot()), fixture.reader.clone());
        let (status, headers, body) = send(
            app,
            &format!("/websites/{SITE}/forms/pilot-eligibility"),
            Some(OWNER),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert_eq!(body["code"], json!("forms_inbox_disabled"));
        assert_eq!(fixture.hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn eligibility_missing_caller_is_401_no_store_and_never_upstream() {
        let fixture = fixture().await;
        let app = app(true, Some(pilot()), fixture.reader.clone());
        let (status, headers, body) = send(
            app,
            &format!("/websites/{SITE}/forms/pilot-eligibility"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert_eq!(body["code"], json!("unauthorized"));
        assert_eq!(fixture.hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn hosts_are_projected_bounded_and_never_expose_challenge_material() {
        let fixture = fixture().await;
        let app = app(true, Some(pilot()), fixture.reader.clone());
        let (status, headers, body) = send(
            app,
            &format!("/websites/{SITE}/forms/hosts?limit=2"),
            Some(OWNER),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert_eq!(body["has_more"], json!(true));
        assert_eq!(body["items"].as_array().unwrap().len(), 2);
        assert_eq!(
            body["items"][0],
            json!({"id": 0, "hostname": "www.example.test", "verified_at": null})
        );
        assert!(!body.to_string().contains("challenge_hash"));
        let query = last_query(&fixture, "website_form_hosts");
        assert_eq!(query["select"], HOST_COLUMNS);
        assert!(!query["select"].contains("challenge_hash"));
        assert_eq!(query["order"], "hostname.asc,id.asc");
        assert_eq!(query["limit"], "3");
    }

    #[tokio::test]
    async fn origins_project_form_and_host_only_and_filter_by_form() {
        let fixture = fixture().await;
        let app = app(true, Some(pilot()), fixture.reader.clone());
        let (status, headers, body) = send(
            app.clone(),
            &format!("/websites/{SITE}/forms/origins?limit=2&form_id={FORM}"),
            Some(OWNER),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert_eq!(body["has_more"], json!(true));
        assert_eq!(body["items"][0], json!({"form_id": FORM, "host_id": 0}));
        let query = last_query(&fixture, "website_form_origins");
        assert_eq!(query["select"], ORIGIN_COLUMNS);
        assert_eq!(query["form_id"], format!("eq.{FORM}"));
        assert_eq!(query["website_id"], format!("eq.{SITE}"));

        let (status, _, _) =
            send(app, &format!("/websites/{SITE}/forms/origins"), Some(OWNER)).await;
        assert_eq!(status, StatusCode::OK);
        assert!(!last_query(&fixture, "website_form_origins").contains_key("form_id"));
    }

    #[tokio::test]
    async fn metadata_rejects_non_pilot_and_malformed_before_upstream() {
        let fixture = fixture().await;
        let app = app(true, Some(pilot()), fixture.reader.clone());
        let not_pilot = [
            (format!("/websites/{OTHER_SITE}/forms/hosts"), OWNER),
            (format!("/websites/{OTHER_SITE}/forms/origins"), OWNER),
            (format!("/websites/{SITE}/forms/hosts"), OTHER_OWNER),
            (format!("/websites/{SITE}/forms/origins"), OTHER_OWNER),
        ];
        for (uri, caller) in not_pilot {
            let (status, headers, body) = send(app.clone(), &uri, Some(caller)).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
            assert_eq!(headers[header::CACHE_CONTROL], "no-store", "{uri}");
            assert_eq!(body["code"], json!("not_found"), "{uri}");
        }
        let malformed = [
            format!("/websites/{SITE}/forms/hosts?limit=0"),
            format!("/websites/{SITE}/forms/hosts?limit=101"),
            format!("/websites/{SITE}/forms/origins?form_id=not-a-uuid"),
            format!("/websites/{SITE}/forms/origins?limit=abc"),
        ];
        for uri in malformed {
            let (status, headers, body) = send(app.clone(), &uri, Some(OWNER)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}");
            assert_eq!(headers[header::CACHE_CONTROL], "no-store", "{uri}");
            assert_eq!(body["code"], json!("invalid_request"), "{uri}");
        }
        assert_eq!(fixture.hits.load(Ordering::SeqCst), 0);
    }
}
