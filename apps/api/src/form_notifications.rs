//! Default-off owner notification management. No worker, privileged key or implicit resend.
//!
//! Exact `true` in `HTP_FORMS_OWNER_NOTIFICATION_API` plus the existing pilot pair
//! permits these authenticated routes. Caller RLS governs reads; the existing
//! write RPCs enforce current ownership and pilot approval transactionally.
//! Request/retry success means queued work, never delivery or verification.
//! `uncertain` is preserved for owner reconciliation: a response resend can
//! duplicate delivery, while an uncertain verification needs a fresh request.
//! All errors are fixed text and all responses are no-store. No privileged key,
//! token, lease, challenge hash, provider payload or upstream error is returned.
use crate::{
    auth::AuthenticatedUser,
    form_inbox::{FormInboxReader, Page, PilotScope},
};
use axum::{
    Extension, Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct NotificationClient {
    url: String,
    key: String,
    client: reqwest::Client,
}
impl NotificationClient {
    pub(crate) fn new(url: &str, key: &str) -> Self {
        Self {
            url: url.trim_end_matches('/').into(),
            key: key.into(),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .build()
                .expect("static client configuration"),
        }
    }
    async fn write(&self, headers: &HeaderMap, ids: Ids, op: Operation) -> Result<Value, Error> {
        let bearer = headers.get(header::AUTHORIZATION).ok_or(UNAUTHORIZED)?;
        let mut params = json!({"p_website_id":ids.id,"p_form_id":ids.form_id});
        let rpc = match &op {
            Operation::Request(email) => {
                params["p_email"] = json!(email);
                "request_form_recipient"
            }
            Operation::Disable => {
                params["p_recipient_id"] = json!(ids.item.ok_or(INVALID)?);
                "disable_form_recipient"
            }
            Operation::Retry => {
                params["p_job_id"] = json!(ids.item.ok_or(INVALID)?);
                "retry_form_delivery"
            }
        };
        let response = self
            .client
            .post(format!("{}/rest/v1/rpc/{rpc}", self.url))
            .header("apikey", &self.key)
            .header(header::AUTHORIZATION, bearer)
            .timeout(std::time::Duration::from_secs(10))
            .json(&params)
            .send()
            .await
            .map_err(|_| UNKNOWN)?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(|_| UNKNOWN)?;
        if status != StatusCode::OK {
            return Err(map_error(status, &bytes));
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| UNKNOWN)?;
        match op {
            Operation::Request(_) => {
                let id = value
                    .as_str()
                    .and_then(|s| Uuid::parse_str(s).ok())
                    .filter(|id| !id.is_nil())
                    .ok_or(UNKNOWN)?;
                Ok(json!({"recipient_id":id,"requested":true}))
            }
            Operation::Disable if value == json!(true) => {
                Ok(json!({"recipient_id":ids.item,"disabled":true}))
            }
            Operation::Retry if value == json!(true) => {
                Ok(json!({"job_id":ids.item,"retry_requested":true}))
            }
            Operation::Retry if value == json!(false) => Err(NOT_RETRYABLE),
            _ => Err(UNKNOWN),
        }
    }
}
#[derive(Clone)]
pub(crate) struct NotificationState {
    client: NotificationClient,
    reader: FormInboxReader,
    enabled: bool,
    pilot: Option<PilotScope>,
}
pub(crate) fn state_from_env(
    client: NotificationClient,
    reader: FormInboxReader,
) -> NotificationState {
    NotificationState {
        client,
        reader,
        enabled: std::env::var("HTP_FORMS_OWNER_NOTIFICATION_API").as_deref() == Ok("true"),
        pilot: crate::form_inbox::pilot_from_env(),
    }
}
#[derive(Clone, Copy, Deserialize)]
struct Ids {
    id: Uuid,
    form_id: Uuid,
    item: Option<Uuid>,
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct Paging {
    limit: Option<usize>,
    offset: Option<usize>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Invitation {
    email: String,
}
#[derive(Clone)]
enum Operation {
    Request(String),
    Disable,
    Retry,
}
#[derive(Clone, Copy, Debug, PartialEq)]
struct Error(StatusCode, &'static str, &'static str);
const DISABLED: Error = Error(
    StatusCode::NOT_FOUND,
    "forms_notifications_disabled",
    "Forms notification API is not enabled.",
);
const UNAUTHORIZED: Error = Error(StatusCode::UNAUTHORIZED, "unauthorized", "Sign in again.");
const NOT_FOUND: Error = Error(
    StatusCode::NOT_FOUND,
    "not_found",
    "Not found or inaccessible.",
);
const INVALID: Error = Error(
    StatusCode::BAD_REQUEST,
    "invalid_request",
    "Invalid notification request.",
);
const UNAVAILABLE: Error = Error(
    StatusCode::SERVICE_UNAVAILABLE,
    "notifications_unavailable",
    "Notification reads are unavailable.",
);
const UNKNOWN: Error = Error(
    StatusCode::SERVICE_UNAVAILABLE,
    "notification_unknown_outcome",
    "The write may or may not have completed. Read back recipients and delivery jobs before another explicit attempt. The request was not retried. An uncertain delivery may already have reached the provider; check delivery before explicitly retrying.",
);
const NOT_RETRYABLE: Error = Error(
    StatusCode::CONFLICT,
    "notification_not_retryable",
    "No retry was queued. Read back delivery jobs before another explicit attempt.",
);
fn map_error(status: StatusCode, bytes: &[u8]) -> Error {
    let code = serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|v| v["code"].as_str().map(str::to_owned));
    match status {
        StatusCode::UNAUTHORIZED => UNAUTHORIZED,
        StatusCode::FORBIDDEN | StatusCode::NOT_FOUND => NOT_FOUND,
        StatusCode::BAD_REQUEST if code.as_deref() == Some("22023") => INVALID,
        _ => UNKNOWN,
    }
}
fn authorize(
    state: &NotificationState,
    caller: Option<Extension<AuthenticatedUser>>,
    ids: Ids,
) -> Result<(), Error> {
    if !state.enabled {
        return Err(DISABLED);
    }
    let pilot = state.pilot.ok_or(DISABLED)?;
    let caller = caller.ok_or(UNAUTHORIZED)?;
    if caller.0.id != pilot.owner_id || ids.id != pilot.website_id {
        return Err(NOT_FOUND);
    }
    Ok(())
}
#[derive(Deserialize, Serialize)]
struct Recipient {
    id: Uuid,
    email: String,
    verified_at: Option<String>,
    enabled: bool,
    created_at: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Verification,
    Response,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum DeliveryState {
    Pending,
    Sending,
    Sent,
    Failed,
    Uncertain,
    Cancelled,
}
#[derive(Deserialize, Serialize)]
struct Job {
    id: Uuid,
    recipient_id: Uuid,
    response_id: Option<Uuid>,
    kind: Kind,
    state: DeliveryState,
    attempts: u32,
    created_at: String,
    updated_at: String,
}
fn project<T: serde::de::DeserializeOwned + Serialize>(
    rows: Vec<Value>,
    page: Page,
) -> Result<Value, Error> {
    if rows.len() > page.limit + 1 {
        return Err(UNAVAILABLE);
    }
    let has_more = rows.len() > page.limit;
    let items = rows
        .into_iter()
        .take(page.limit)
        .map(serde_json::from_value::<T>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| UNAVAILABLE)?;
    Ok(json!({"items":items,"has_more":has_more}))
}
pub(crate) fn router(state: NotificationState) -> Router {
    Router::new()
        .route(
            "/websites/{id}/forms/{form_id}/recipients",
            get(recipients).post(request),
        )
        .route("/websites/{id}/forms/{form_id}/delivery-jobs", get(jobs))
        .route(
            "/websites/{id}/forms/{form_id}/recipients/{item}/disable",
            post(disable),
        )
        .route(
            "/websites/{id}/forms/{form_id}/delivery-jobs/{item}/retry",
            post(retry),
        )
        .layer(DefaultBodyLimit::max(1024))
        .with_state(state)
}
type Caller = Option<Extension<AuthenticatedUser>>;
type IdPath = Result<Path<Ids>, axum::extract::rejection::PathRejection>;
type PageQuery = Result<Query<Paging>, axum::extract::rejection::QueryRejection>;
async fn read(
    state: NotificationState,
    caller: Caller,
    headers: HeaderMap,
    path: IdPath,
    query: PageQuery,
    jobs: bool,
) -> Result<Value, Error> {
    let ids = path.map_err(|_| INVALID)?.0;
    authorize(&state, caller, ids)?;
    let page = query.map_err(|_| INVALID)?.0;
    let page = Page::parse(page.limit, page.offset).map_err(|_| INVALID)?;
    // Inner recipient join scopes jobs to this exact website and form, under caller RLS.
    let (table, columns, site_key, form_key) = if jobs {
        (
            "website_form_delivery_jobs",
            "id,recipient_id,response_id,kind,state,attempts,created_at,updated_at,website_form_recipients!inner(website_id,form_id)",
            "website_form_recipients.website_id",
            "website_form_recipients.form_id",
        )
    } else {
        (
            "website_form_recipients",
            "id,email,verified_at,enabled,created_at",
            "website_id",
            "form_id",
        )
    };
    let rows = state
        .reader
        .get_rows(
            &headers,
            table,
            &[
                ("select", columns.into()),
                (site_key, format!("eq.{}", ids.id)),
                (form_key, format!("eq.{}", ids.form_id)),
                ("order", "created_at.desc,id.asc".into()),
                ("limit", (page.limit + 1).to_string()),
                ("offset", page.offset.to_string()),
            ],
        )
        .await
        .map_err(|e| match e.status {
            StatusCode::UNAUTHORIZED => UNAUTHORIZED,
            StatusCode::FORBIDDEN | StatusCode::NOT_FOUND => NOT_FOUND,
            _ => UNAVAILABLE,
        })?;
    if jobs {
        project::<Job>(rows, page)
    } else {
        project::<Recipient>(rows, page)
    }
}
async fn recipients(
    State(state): State<NotificationState>,
    caller: Caller,
    headers: HeaderMap,
    path: IdPath,
    query: PageQuery,
) -> Response {
    respond(read(state, caller, headers, path, query, false).await)
}
async fn jobs(
    State(state): State<NotificationState>,
    caller: Caller,
    headers: HeaderMap,
    path: IdPath,
    query: PageQuery,
) -> Response {
    respond(read(state, caller, headers, path, query, true).await)
}
enum WriteKind {
    Request,
    Disable,
    Retry,
}
async fn write(
    state: NotificationState,
    caller: Caller,
    headers: HeaderMap,
    path: IdPath,
    body: Result<Bytes, axum::extract::rejection::BytesRejection>,
    kind: WriteKind,
) -> Result<Value, Error> {
    let ids = path.map_err(|_| INVALID)?.0;
    authorize(&state, caller, ids)?;
    let bytes = body.map_err(|_| INVALID)?;
    let op = if matches!(kind, WriteKind::Request) {
        if !headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.split(';')
                    .next()
                    .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
            })
        {
            return Err(INVALID);
        }
        let body: Invitation = serde_json::from_slice(&bytes).map_err(|_| INVALID)?;
        if body.email.len() > 254
            || body.email.len() < 3
            || body
                .email
                .chars()
                .any(|character| character.is_whitespace() || character.is_control())
            || !body.email.contains('@')
        {
            return Err(INVALID);
        }
        Operation::Request(body.email)
    } else {
        if !bytes.is_empty() {
            return Err(INVALID);
        }
        if matches!(kind, WriteKind::Disable) {
            Operation::Disable
        } else {
            Operation::Retry
        }
    };
    state.client.write(&headers, ids, op).await
}
async fn request(
    State(state): State<NotificationState>,
    caller: Caller,
    headers: HeaderMap,
    path: IdPath,
    body: Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Response {
    respond(write(state, caller, headers, path, body, WriteKind::Request).await)
}
async fn disable(
    State(state): State<NotificationState>,
    caller: Caller,
    headers: HeaderMap,
    path: IdPath,
    body: Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Response {
    respond(write(state, caller, headers, path, body, WriteKind::Disable).await)
}
async fn retry(
    State(state): State<NotificationState>,
    caller: Caller,
    headers: HeaderMap,
    path: IdPath,
    body: Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Response {
    respond(write(state, caller, headers, path, body, WriteKind::Retry).await)
}
fn respond(result: Result<Value, Error>) -> Response {
    let (status, value) = match result {
        Ok(v) => (StatusCode::OK, v),
        Err(Error(status, code, message)) => (status, json!({"code":code,"error":message})),
    };
    (status, [(header::CACHE_CONTROL, "no-store")], Json(value)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;
    fn ids() -> Ids {
        Ids {
            id: Uuid::from_u128(1),
            form_id: Uuid::from_u128(2),
            item: Some(Uuid::from_u128(3)),
        }
    }
    fn state(url: &str) -> NotificationState {
        NotificationState {
            client: NotificationClient::new(url, "publishable-fixture"),
            reader: FormInboxReader::new(url, "publishable-fixture"),
            enabled: true,
            pilot: Some(PilotScope {
                website_id: ids().id,
                owner_id: Uuid::from_u128(4),
            }),
        }
    }
    fn caller() -> Extension<AuthenticatedUser> {
        Extension(AuthenticatedUser {
            id: Uuid::from_u128(4),
        })
    }
    #[test]
    fn scope_and_default_off() {
        let mut s = state("http://127.0.0.1:1");
        assert_eq!(authorize(&s, None, ids()), Err(UNAUTHORIZED));
        assert_eq!(
            authorize(
                &s,
                Some(Extension(AuthenticatedUser {
                    id: Uuid::from_u128(9)
                })),
                ids()
            ),
            Err(NOT_FOUND)
        );
        assert_eq!(
            authorize(
                &s,
                Some(caller()),
                Ids {
                    id: Uuid::from_u128(9),
                    ..ids()
                }
            ),
            Err(NOT_FOUND)
        );
        s.enabled = false;
        assert_eq!(authorize(&s, Some(caller()), ids()), Err(DISABLED));
        s.enabled = true;
        s.pilot = None;
        assert_eq!(authorize(&s, Some(caller()), ids()), Err(DISABLED));
    }
    #[test]
    fn typed_projection_preserves_uncertainty_and_omits_secrets() {
        let row = json!({"id":ids().item,"recipient_id":ids().id,"response_id":ids().form_id,"kind":"response","state":"uncertain","attempts":1,"created_at":"date","updated_at":"date","secret_token":"private","lease":"private","provider_error":"private","website_form_recipients":{"challenge_hash":"private"}});
        let result = project::<Job>(
            vec![row.clone(), row],
            Page {
                limit: 1,
                offset: 0,
            },
        )
        .unwrap();
        assert_eq!(result["has_more"], true);
        assert_eq!(result["items"][0]["state"], "uncertain");
        assert!(!result.to_string().contains("private"));
        let row = json!({"id":ids().id,"email":"fixture@example.test","verified_at":null,"enabled":true,"created_at":"date","challenge_hash":"private"});
        assert!(
            !project::<Recipient>(
                vec![row],
                Page {
                    limit: 50,
                    offset: 0
                }
            )
            .unwrap()
            .to_string()
            .contains("private")
        );
        assert_eq!(
            project::<Job>(
                vec![json!({})],
                Page {
                    limit: 50,
                    offset: 0
                }
            ),
            Err(UNAVAILABLE)
        );
    }
    async fn fixture(
        status: StatusCode,
        reply: Value,
    ) -> (
        NotificationState,
        Arc<Mutex<Vec<(HeaderMap, Value, String)>>>,
        tokio::task::JoinHandle<()>,
    ) {
        let seen = Arc::new(Mutex::new(vec![]));
        let captured = seen.clone();
        let app = Router::new().route(
            "/rest/v1/rpc/{rpc}",
            post(
                move |Path(rpc): Path<String>, headers: HeaderMap, Json(params): Json<Value>| {
                    let seen = captured.clone();
                    let reply = reply.clone();
                    async move {
                        seen.lock().unwrap().push((headers, params, rpc));
                        (status, Json(reply))
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let s = state(&format!("http://{}", listener.local_addr().unwrap()));
        let handle = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (s, seen, handle)
    }
    #[tokio::test]
    async fn exact_write_semantics_and_no_retry() {
        for (op, rpc, reply, key) in [
            (
                Operation::Request("fixture@example.test".into()),
                "request_form_recipient",
                json!(Uuid::from_u128(5)),
                "requested",
            ),
            (
                Operation::Disable,
                "disable_form_recipient",
                json!(true),
                "disabled",
            ),
            (
                Operation::Retry,
                "retry_form_delivery",
                json!(true),
                "retry_requested",
            ),
        ] {
            let (s, seen, server) = fixture(StatusCode::OK, reply).await;
            let mut headers = HeaderMap::new();
            headers.insert(
                header::AUTHORIZATION,
                "Bearer verified-user-fixture".parse().unwrap(),
            );
            assert_eq!(
                s.client.write(&headers, ids(), op).await.unwrap()[key],
                true
            );
            let seen = seen.lock().unwrap();
            assert_eq!(seen.len(), 1);
            assert_eq!(
                seen[0].0[header::AUTHORIZATION],
                "Bearer verified-user-fixture"
            );
            assert_eq!(seen[0].0["apikey"], "publishable-fixture");
            assert_eq!(seen[0].2, rpc);
            assert_eq!(seen[0].1["p_website_id"], json!(ids().id));
            assert_eq!(seen[0].1["p_form_id"], json!(ids().form_id));
            match rpc {
                "request_form_recipient" => assert_eq!(
                    seen[0].1,
                    json!({"p_website_id":ids().id,"p_form_id":ids().form_id,"p_email":"fixture@example.test"})
                ),
                "disable_form_recipient" => {
                    assert_eq!(seen[0].1["p_recipient_id"], json!(ids().item));
                }
                _ => {
                    assert_eq!(seen[0].1["p_job_id"], json!(ids().item));
                }
            }
            server.abort();
        }
        for (status, reply, expected) in [
            (StatusCode::OK, json!(false), NOT_RETRYABLE),
            (StatusCode::OK, json!({"secret_token":"private"}), UNKNOWN),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"message":"private"}),
                UNKNOWN,
            ),
            (
                StatusCode::FORBIDDEN,
                json!({"message":"private"}),
                NOT_FOUND,
            ),
            (
                StatusCode::BAD_REQUEST,
                json!({"code":"22023","message":"private"}),
                INVALID,
            ),
        ] {
            let (s, seen, server) = fixture(status, reply).await;
            let mut h = HeaderMap::new();
            h.insert(header::AUTHORIZATION, "Bearer fixture".parse().unwrap());
            assert_eq!(
                s.client.write(&h, ids(), Operation::Retry).await,
                Err(expected)
            );
            assert_eq!(seen.lock().unwrap().len(), 1);
            server.abort();
        }
    }
    #[tokio::test]
    async fn ambiguous_writes_require_readback_for_every_operation() {
        for op in [
            Operation::Request("fixture@example.test".into()),
            Operation::Disable,
            Operation::Retry,
        ] {
            for (status, reply) in [
                (StatusCode::OK, json!({"token":"private"})),
                (StatusCode::CREATED, json!(true)),
                (StatusCode::TEMPORARY_REDIRECT, json!(true)),
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({"message":"private provider failure"}),
                ),
            ] {
                let (s, seen, server) = fixture(status, reply).await;
                let mut headers = HeaderMap::new();
                headers.insert(header::AUTHORIZATION, "Bearer fixture".parse().unwrap());
                let error = s
                    .client
                    .write(&headers, ids(), op.clone())
                    .await
                    .unwrap_err();
                assert_eq!(error, UNKNOWN);
                assert!(error.2.contains("Read back"));
                assert!(error.2.contains("not retried"));
                assert!(!error.2.contains("private"));
                assert_eq!(seen.lock().unwrap().len(), 1);
                server.abort();
            }
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            drop(listener);
            let s = state(&url);
            let mut headers = HeaderMap::new();
            headers.insert(header::AUTHORIZATION, "Bearer fixture".parse().unwrap());
            assert_eq!(s.client.write(&headers, ids(), op).await, Err(UNKNOWN));
        }
    }
    #[tokio::test]
    async fn invalid_page_body_and_missing_bearer_are_safe() {
        let s = state("http://127.0.0.1:1");
        for limit in [0, 101] {
            assert_eq!(
                read(
                    s.clone(),
                    Some(caller()),
                    HeaderMap::new(),
                    Ok(Path(ids())),
                    Ok(Query(Paging {
                        limit: Some(limit),
                        offset: None
                    })),
                    false
                )
                .await,
                Err(INVALID)
            );
        }
        assert_eq!(
            s.client
                .write(&HeaderMap::new(), ids(), Operation::Retry)
                .await,
            Err(UNAUTHORIZED)
        );
        let mut req = Request::builder()
            .method("POST")
            .uri(format!(
                "/websites/{}/forms/{}/recipients",
                ids().id,
                ids().form_id
            ))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("x".repeat(1025)))
            .unwrap();
        req.extensions_mut().insert(AuthenticatedUser {
            id: Uuid::from_u128(4),
        });
        let response = router(s).oneshot(req).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }
    #[tokio::test]
    async fn routes_reject_foreign_callers_and_invalid_bodies_before_network() {
        for suffix in [
            "recipients",
            "delivery-jobs",
            "recipients/00000000-0000-0000-0000-000000000003/disable",
            "delivery-jobs/00000000-0000-0000-0000-000000000003/retry",
        ] {
            let uri = format!("/websites/{}/forms/{}/{suffix}", ids().id, ids().form_id);
            for method in ["GET", "POST"] {
                if method == "GET" && suffix.contains('/')
                    || method == "POST" && suffix == "delivery-jobs"
                {
                    continue;
                }
                let mut request = Request::builder()
                    .method(method)
                    .uri(&uri)
                    .body(Body::empty())
                    .unwrap();
                request.extensions_mut().insert(AuthenticatedUser {
                    id: Uuid::from_u128(9),
                });
                let response = router(state("http://127.0.0.1:1"))
                    .oneshot(request)
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::NOT_FOUND);
                assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            }
        }
        let s = state("http://127.0.0.1:1");
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        assert_eq!(
            write(
                s.clone(),
                Some(caller()),
                headers,
                Ok(Path(ids())),
                Ok(Bytes::from_static(
                    b"{\"email\":\"a@b.test\",\"token\":\"private\"}"
                )),
                WriteKind::Request
            )
            .await,
            Err(INVALID)
        );
        assert_eq!(
            write(
                s,
                Some(caller()),
                HeaderMap::new(),
                Ok(Path(ids())),
                Ok(Bytes::from_static(b"{}")),
                WriteKind::Retry
            )
            .await,
            Err(INVALID)
        );
    }
    #[tokio::test]
    async fn reads_scope_page_and_strip_unexpected_upstream_fields() {
        let seen = Arc::new(Mutex::new(vec![]));
        let capture = seen.clone();
        let app=Router::new().route("/rest/v1/{table}",get(move |Path(table):Path<String>,Query(query):Query<std::collections::HashMap<String,String>>,headers:HeaderMap|{let seen=capture.clone();async move {
            seen.lock().unwrap().push((table.clone(),query,headers));
            if table=="website_form_recipients" {Json(json!([{"id":ids().id,"email":"fixture@example.test","verified_at":null,"enabled":true,"created_at":"date","secret_token":"private"}]))}else{Json(json!([{"id":ids().item,"recipient_id":ids().id,"response_id":null,"kind":"verification","state":"uncertain","attempts":1,"created_at":"date","updated_at":"date","secret_token":"private"}]))}
        }}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let s = state(&format!("http://{}", listener.local_addr().unwrap()));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        for jobs in [false, true] {
            let mut h = HeaderMap::new();
            h.insert(header::AUTHORIZATION, "Bearer fixture".parse().unwrap());
            let result = read(
                s.clone(),
                Some(caller()),
                h,
                Ok(Path(ids())),
                Ok(Query(Paging {
                    limit: Some(1),
                    offset: Some(7),
                })),
                jobs,
            )
            .await
            .unwrap();
            assert!(!result.to_string().contains("private"));
        }
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        for (table, q, h) in seen.iter() {
            assert_eq!(h[header::AUTHORIZATION], "Bearer fixture");
            assert_eq!(q["limit"], "2");
            assert_eq!(q["offset"], "7");
            let prefix = if table == "website_form_delivery_jobs" {
                "website_form_recipients."
            } else {
                ""
            };
            assert_eq!(
                q[&format!("{prefix}website_id")],
                format!("eq.{}", ids().id)
            );
            assert_eq!(
                q[&format!("{prefix}form_id")],
                format!("eq.{}", ids().form_id)
            );
            assert!(!q["select"].contains("secret"));
        }
        server.abort();
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
        let app = router(NotificationState {
            client: NotificationClient::new("http://127.0.0.1:1", "synthetic"),
            reader: FormInboxReader::new("http://127.0.0.1:1", "synthetic"),
            enabled: true,
            pilot: Some(pilot),
        })
        .layer(middleware::from_fn_with_state(
            crate::auth::SupabaseAuth::new(&origin),
            crate::auth::require_user,
        ));
        for method in [Method::GET, Method::POST] {
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
                    "/websites/{}/forms/{}/recipients",
                    pilot.website_id,
                    Uuid::from_u128(3)
                );
                let response = app
                    .clone()
                    .oneshot(
                        Request::builder()
                            .method(method.clone())
                            .uri(uri)
                            .header(header::AUTHORIZATION, format!("Bearer {token}"))
                            .header(header::CONTENT_TYPE, "application/json")
                            .body(Body::from(if method == Method::POST {
                                r#"{"email":"fixture@example.test"}"#
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
