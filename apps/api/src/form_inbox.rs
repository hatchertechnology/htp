//! Owner-scoped, read-only Forms list and inbox response list/detail.
//!
//! Every read runs as the caller: the caller's Supabase bearer is forwarded with
//! the publishable key to PostgREST, so the owner read policies on
//! `website_forms` and `website_form_responses` decide what is visible. No
//! privileged key is used. The feature is default-off and fails closed.
//!
//! Projections and caps match the dashboard reads in
//! `apps/web/app/components/WebsiteForms.vue`: forms and responses only, with
//! offset paging capped at 100 rows. Recipient and delivery-job tables are not
//! read here, which keeps the pilot condition (no notification state) intact.
//! Pilot approval is a database table with no API-reachable grant, so the API
//! cannot check it; the enablement flag below is the only API-side gate.

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};
use std::time::Duration;
use uuid::Uuid;

/// Environment flag. Only the exact value `true` enables the routes.
pub(crate) const ENABLE_VAR: &str = "HTP_FORMS_OWNER_INBOX_API";

pub(crate) fn enabled_from_env() -> bool {
    std::env::var(ENABLE_VAR).as_deref() == Ok("true")
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
    message: "Invalid limit or offset. Limit must be 1 to 100.",
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
}

#[derive(serde::Deserialize)]
struct PageQuery {
    limit: Option<usize>,
    offset: Option<usize>,
}

/// Authenticated read-only routes, merged behind `auth::require_user`:
///   GET /websites/{id}/forms
///   GET /websites/{id}/forms/{form_id}/responses
///   GET /websites/{id}/forms/{form_id}/responses/{response_id}
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

async fn list_forms(
    State(state): State<FormInboxState>,
    Path(website_id): Path<Uuid>,
    headers: HeaderMap,
    Query(query): Query<PageQuery>,
) -> Response {
    let result = async {
        ensure_enabled(&state)?;
        let page = Page::parse(query.limit, query.offset)?;
        state.reader.list_forms(&headers, website_id, page).await
    }
    .await;
    respond(result)
}

async fn list_responses(
    State(state): State<FormInboxState>,
    Path((website_id, form_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Query(query): Query<PageQuery>,
) -> Response {
    let result = async {
        ensure_enabled(&state)?;
        let page = Page::parse(query.limit, query.offset)?;
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
    Path((website_id, form_id, response_id)): Path<(Uuid, Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let result = async {
        ensure_enabled(&state)?;
        state
            .reader
            .response_detail(&headers, website_id, form_id, response_id)
            .await
    }
    .await;
    respond(result)
}

fn ensure_enabled(state: &FormInboxState) -> Result<(), InboxError> {
    if state.enabled {
        Ok(())
    } else {
        Err(NOT_ENABLED)
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
    use axum::{Router, extract::Query as AxQuery, routing::get as axget};
    use std::collections::HashMap;

    const SITE: &str = "00000000-0000-0000-0000-000000000001";
    const FORM: &str = "00000000-0000-0000-0000-000000000002";
    const RESPONSE: &str = "00000000-0000-0000-0000-000000000003";

    fn bearer() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer owner-token".parse().unwrap());
        headers
    }

    fn uuid(value: &str) -> Uuid {
        Uuid::parse_str(value).unwrap()
    }

    /// A local fixture PostgREST. It only answers when the caller's bearer and
    /// publishable key are forwarded, and echoes the query it received so tests
    /// can check the exact projection, filters, ordering and limit.
    async fn fixture() -> FormInboxReader {
        async fn echo(
            headers: HeaderMap,
            AxQuery(query): AxQuery<HashMap<String, String>>,
        ) -> Response {
            if headers.get("authorization").and_then(|v| v.to_str().ok())
                != Some("Bearer owner-token")
                || headers.get("apikey").and_then(|v| v.to_str().ok()) != Some("test-publishable")
            {
                return (StatusCode::UNAUTHORIZED, "{}").into_response();
            }
            let limit: usize = query.get("limit").and_then(|v| v.parse().ok()).unwrap_or(0);
            let rows: Vec<Value> = (0..limit.min(3))
                .map(|i| json!({"id": i, "select": query.get("select")}))
                .collect();
            Json(Value::Array(rows)).into_response()
        }
        let app = Router::new()
            .route("/rest/v1/website_forms", axget(echo))
            .route("/rest/v1/website_form_responses", axget(echo));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        FormInboxReader::new(&origin, "test-publishable")
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
        };
        assert_eq!(ensure_enabled(&state), Err(NOT_ENABLED));
        assert_eq!(NOT_ENABLED.status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn list_forms_uses_dashboard_projection_and_reports_has_more() {
        let reader = fixture().await;
        // Limit 2 asks upstream for 3 rows; three rows returned means has_more.
        let page = Page {
            limit: 2,
            offset: 0,
        };
        let value = reader
            .list_forms(&bearer(), uuid(SITE), page)
            .await
            .unwrap();
        assert_eq!(value["has_more"], json!(true));
        assert_eq!(value["items"].as_array().unwrap().len(), 2);
        assert_eq!(value["items"][0]["select"], json!(FORM_COLUMNS));
    }

    #[tokio::test]
    async fn list_responses_is_paged_without_recipient_or_job_reads() {
        let reader = fixture().await;
        let page = Page {
            limit: 5,
            offset: 0,
        };
        let value = reader
            .list_responses(&bearer(), uuid(SITE), uuid(FORM), page)
            .await
            .unwrap();
        assert_eq!(value["has_more"], json!(false));
        assert_eq!(value["items"][0]["select"], json!(RESPONSE_COLUMNS));
        assert!(!RESPONSE_COLUMNS.contains("recipient"));
        assert!(!RESPONSE_COLUMNS.contains("delivery"));
    }

    #[tokio::test]
    async fn detail_requires_exactly_one_row() {
        let reader = fixture().await;
        // The fixture returns `limit` rows, so detail (limit 1) finds one row.
        let found = reader
            .response_detail(&bearer(), uuid(SITE), uuid(FORM), uuid(RESPONSE))
            .await
            .unwrap();
        assert_eq!(found["select"], json!(RESPONSE_COLUMNS));
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
        let reader = fixture().await;
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer wrong".parse().unwrap());
        let page = Page {
            limit: 1,
            offset: 0,
        };
        assert_eq!(
            reader.list_forms(&headers, uuid(SITE), page).await,
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
}
