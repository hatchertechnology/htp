//! Authenticated website persistence through Supabase's user-scoped Data API.

use std::time::{Duration, Instant};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::StreamExt;
use htp_shared::{Website, WebsiteInput, WebsitePage, normalize_fqdn};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

/// Client deadline for a Data API RPC. The two Seosmith ingest RPCs have a
/// bounded 20s database statement budget (migration 20261117120000), so their
/// client deadline stays strictly above it; every other RPC keeps 10s.
fn rpc_deadline(name: &str) -> Duration {
    if name == "import_seosmith_audit" {
        Duration::from_secs(25)
    } else {
        Duration::from_secs(10)
    }
}

/// User-scoped access to Supabase; no privileged database credential is used.
#[derive(Clone)]
pub struct WebsiteStore {
    url: String,
    publishable_key: String,
    client: reqwest::Client,
}

impl WebsiteStore {
    pub(crate) fn forms_notification_client(
        &self,
    ) -> crate::form_notifications::NotificationClient {
        let project = self
            .url
            .strip_suffix("/rest/v1/websites")
            .unwrap_or(&self.url);
        crate::form_notifications::NotificationClient::new(project, &self.publishable_key)
    }

    /// Forms verification uses the same project and publishable key as the store.
    pub(crate) fn forms_verifier(&self) -> crate::form_verification::FormVerifier {
        let project = self
            .url
            .strip_suffix("/rest/v1/websites")
            .unwrap_or(&self.url);
        crate::form_verification::FormVerifier::new(project, &self.publishable_key)
    }

    /// Owner Forms create/update uses the same project and publishable key as the store.
    pub(crate) fn forms_saver(&self) -> crate::form_save::FormSaver {
        let project = self
            .url
            .strip_suffix("/rest/v1/websites")
            .unwrap_or(&self.url);
        crate::form_save::FormSaver::new(project, &self.publishable_key)
    }

    /// Response writes use the same trusted project and publishable key.
    pub(crate) fn forms_response_writer(&self) -> crate::form_responses::ResponseWriter {
        let project = self
            .url
            .strip_suffix("/rest/v1/websites")
            .unwrap_or(&self.url);
        crate::form_responses::ResponseWriter::new(project, &self.publishable_key)
    }

    /// Owner Forms inbox reads use the same project and publishable key as the store.
    pub(crate) fn forms_reader(&self) -> crate::form_inbox::FormInboxReader {
        let project = self
            .url
            .strip_suffix("/rest/v1/websites")
            .unwrap_or(&self.url);
        crate::form_inbox::FormInboxReader::new(project, &self.publishable_key)
    }

    pub(crate) async fn list_saved(
        &self,
        headers: &HeaderMap,
        limit: usize,
        offset: usize,
    ) -> Result<WebsitePage, WebsiteError> {
        if !(1..=100).contains(&limit) {
            return Err(WebsiteError::Invalid("Limit must be between 1 and 100."));
        }
        let mut items = self
            .request(
                Method::GET,
                headers,
                &[
                    ("order", "fqdn.asc,id.asc".to_owned()),
                    ("limit", (limit + 1).to_string()),
                    ("offset", offset.to_string()),
                ],
                None,
            )
            .await?;
        let has_more = items.len() > limit;
        items.truncate(limit);
        Ok(WebsitePage { items, has_more })
    }

    /// Read the latest snapshot and register an hourly refresh subscription.
    /// The database RPC checks ownership independently of the HTTP handler.
    pub(crate) async fn saved_report(
        &self,
        headers: &HeaderMap,
        id: Uuid,
        kind: &str,
        property: &str,
        start: &str,
        end: &str,
    ) -> Result<Value, WebsiteError> {
        self.rpc(headers, "request_google_report", json!({"p_website_id":id,"p_kind":kind,"p_property_id":property,"p_start_date":start,"p_end_date":end})).await
    }

    pub(crate) async fn rpc(
        &self,
        headers: &HeaderMap,
        name: &str,
        body: Value,
    ) -> Result<Value, WebsiteError> {
        let authorization = headers
            .get(header::AUTHORIZATION)
            .ok_or(WebsiteError::Unauthorized)?;
        let started = Instant::now();
        let timeout = rpc_deadline(name);
        let diagnostic_id = (name == "import_seosmith_audit").then(Uuid::new_v4);
        let request = self
            .client
            .post(format!(
                "{}/rpc/{name}",
                self.url.trim_end_matches("/websites")
            ))
            .header("apikey", &self.publishable_key)
            .header(header::AUTHORIZATION, authorization)
            .timeout(timeout)
            .json(&body);
        let request = if let Some(id) = diagnostic_id {
            eprintln!(
                "seosmith owner diagnostic_id={id} phase=request_built elapsed_ms={}",
                started.elapsed().as_millis()
            );
            request.header("traceparent", ingest_traceparent(id))
        } else {
            request
        };
        let response = request.send().await.map_err(|error| {
            if name == "import_seosmith_audit" {
                log_ingest_failure("owner", diagnostic_id.unwrap(), started, &error);
            }
            WebsiteError::Unavailable
        })?;
        if let Some(id) = diagnostic_id {
            eprintln!(
                "seosmith owner diagnostic_id={id} phase=response_headers status={} elapsed_ms={}",
                response.status().as_u16(),
                started.elapsed().as_millis()
            );
        }
        if name == "import_seosmith_audit" && response.status() == StatusCode::INTERNAL_SERVER_ERROR
        {
            log_ingest_server_error("owner", diagnostic_id.unwrap(), started, response).await;
            return Err(WebsiteError::Unavailable);
        }
        if name == "import_seosmith_audit" && !response.status().is_success() {
            eprintln!(
                "seosmith owner diagnostic_id={} upstream status={} elapsed_ms={}",
                diagnostic_id.unwrap(),
                response.status().as_u16(),
                started.elapsed().as_millis()
            );
        }
        if crate::independent_audit::is_rpc(name) && response.status() == StatusCode::BAD_REQUEST {
            let value: Value = response
                .json()
                .await
                .map_err(|_| WebsiteError::Unavailable)?;
            return Err(WebsiteError::Invalid(
                crate::independent_audit::validation_message(&value)
                    .unwrap_or("Invalid independent evidence request."),
            ));
        }
        if crate::independent_audit::is_rpc(name)
            && !response.status().is_success()
            && !matches!(
                response.status(),
                StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
            )
        {
            return Err(WebsiteError::Independent(
                response.status(),
                "Independent evidence request failed.",
            ));
        }
        match response.status() {
            StatusCode::UNAUTHORIZED => return Err(WebsiteError::Unauthorized),
            StatusCode::FORBIDDEN => return Err(WebsiteError::Forbidden),
            StatusCode::CONFLICT if name == "import_seosmith_audit" => {
                return Err(WebsiteError::Invalid(
                    "A different report already uses this run ID.",
                ));
            }
            StatusCode::BAD_REQUEST if name == "import_seosmith_audit" => {
                return Err(WebsiteError::Invalid(
                    "Report could not be imported. Check its hostname, run ID, format, and timestamps.",
                ));
            }
            StatusCode::BAD_REQUEST => {
                return Err(WebsiteError::Invalid(
                    "Invalid report source, range, or location binding.",
                ));
            }
            status if !status.is_success() => return Err(WebsiteError::Unavailable),
            _ => {}
        }
        let result = response.json().await.map_err(|error| {
            if name == "import_seosmith_audit" {
                log_ingest_failure("owner", diagnostic_id.unwrap(), started, &error);
            }
            WebsiteError::Unavailable
        });
        if let Some(id) = diagnostic_id
            && result.is_ok()
        {
            eprintln!(
                "seosmith owner diagnostic_id={id} phase=response_decoded elapsed_ms={}",
                started.elapsed().as_millis()
            );
        }
        result
    }

    /// Forward detail JSON without building a heap object for every report token.
    pub(crate) async fn seosmith_detail(
        &self,
        headers: &HeaderMap,
        website_id: Uuid,
        delivery_id: Uuid,
    ) -> Result<Option<Body>, WebsiteError> {
        let authorization = headers
            .get(header::AUTHORIZATION)
            .ok_or(WebsiteError::Unauthorized)?;
        let mut response = self
            .client
            .post(format!(
                "{}/rpc/seosmith_audit_detail",
                self.url.trim_end_matches("/websites")
            ))
            .header("apikey", &self.publishable_key)
            .header(header::AUTHORIZATION, authorization)
            .timeout(Duration::from_secs(10))
            .json(&json!({"p_website_id":website_id,"p_delivery_id":delivery_id}))
            .send()
            .await
            .map_err(|_| WebsiteError::Unavailable)?;
        match response.status() {
            StatusCode::UNAUTHORIZED => return Err(WebsiteError::Unauthorized),
            StatusCode::FORBIDDEN => return Err(WebsiteError::Forbidden),
            StatusCode::BAD_REQUEST => {
                return Err(WebsiteError::Invalid(
                    "Invalid report source, range, or location binding.",
                ));
            }
            status if !status.is_success() => return Err(WebsiteError::Unavailable),
            _ => {}
        }
        // PostgREST returns a JSON object or null. Skip JSON whitespace without
        // accumulating it, then stream the object with downstream backpressure.
        // After headers are committed, upstream errors terminate the body stream.
        let mut null_pos = 0;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| WebsiteError::Unavailable)?
        {
            let mut index = 0;
            while index < chunk.len() {
                let byte = chunk[index];
                if null_pos == 0 && matches!(byte, b' ' | b'\t' | b'\r' | b'\n') {
                    index += 1;
                    continue;
                }
                if null_pos == 0 && byte == b'{' {
                    let prefix = chunk.slice(index..);
                    let stream =
                        futures_util::stream::once(async move { Ok::<_, reqwest::Error>(prefix) })
                            .chain(response.bytes_stream());
                    return Ok(Some(Body::from_stream(stream)));
                }
                if null_pos < 4 && byte == b"null"[null_pos] {
                    null_pos += 1;
                } else if null_pos != 4 || !matches!(byte, b' ' | b'\t' | b'\r' | b'\n') {
                    return Err(WebsiteError::Unavailable);
                }
                index += 1;
            }
        }
        if null_pos == 4 {
            Ok(None)
        } else {
            Err(WebsiteError::Unavailable)
        }
    }

    /// Read installed receiver support without advertising uninstalled migrations.
    pub(crate) async fn seosmith_capabilities(&self) -> Result<Value, WebsiteError> {
        let response = self
            .client
            .post(format!(
                "{}/rpc/seosmith_receiver_capabilities",
                self.url.trim_end_matches("/websites")
            ))
            .header("apikey", &self.publishable_key)
            .timeout(Duration::from_secs(10))
            .json(&json!({}))
            .send()
            .await
            .map_err(|_| WebsiteError::Unavailable)?;
        if !response.status().is_success() {
            return Err(WebsiteError::Unavailable);
        }
        response.json().await.map_err(|_| WebsiteError::Unavailable)
    }

    /// Token-authenticated ingestion. The database binds the credential to one website.
    pub(crate) async fn ingest_seosmith(&self, body: Value) -> Result<Value, WebsiteError> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            // Above the bounded 20s database budget for ingest_seosmith_audit.
            .timeout(Duration::from_secs(25))
            .build()
            .map_err(|_| WebsiteError::Unavailable)?;
        let started = Instant::now();
        let diagnostic_id = Uuid::new_v4();
        let request = client
            .post(format!(
                "{}/rpc/ingest_seosmith_audit",
                self.url.trim_end_matches("/websites")
            ))
            .header("apikey", &self.publishable_key)
            .header("traceparent", ingest_traceparent(diagnostic_id))
            .json(&body);
        eprintln!(
            "seosmith worker diagnostic_id={diagnostic_id} phase=request_built elapsed_ms={}",
            started.elapsed().as_millis()
        );
        let response = request.send().await.map_err(|error| {
            log_ingest_failure("worker", diagnostic_id, started, &error);
            WebsiteError::Unavailable
        })?;
        eprintln!(
            "seosmith worker diagnostic_id={diagnostic_id} phase=response_headers status={} elapsed_ms={}",
            response.status().as_u16(),
            started.elapsed().as_millis()
        );
        if response.status() == StatusCode::INTERNAL_SERVER_ERROR {
            log_ingest_server_error("worker", diagnostic_id, started, response).await;
            return Err(WebsiteError::Unavailable);
        }
        if !response.status().is_success() {
            eprintln!(
                "seosmith worker diagnostic_id={diagnostic_id} upstream status={} elapsed_ms={}",
                response.status().as_u16(),
                started.elapsed().as_millis()
            );
        }
        match response.status() {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                return Err(WebsiteError::Unauthorized);
            }
            StatusCode::BAD_REQUEST | StatusCode::CONFLICT => {
                return Err(WebsiteError::Invalid(
                    "Invalid or conflicting Seosmith delivery.",
                ));
            }
            s if !s.is_success() => return Err(WebsiteError::Unavailable),
            _ => {}
        }
        let result = response.json().await.map_err(|error| {
            log_ingest_failure("worker", diagnostic_id, started, &error);
            WebsiteError::Unavailable
        });
        if result.is_ok() {
            eprintln!(
                "seosmith worker diagnostic_id={diagnostic_id} phase=response_decoded elapsed_ms={}",
                started.elapsed().as_millis()
            );
        }
        result
    }

    /// Schema-4 commit. The service key is sent only here, only to
    /// `commit_seosmith_audit_v4` (EXECUTE is granted to `service_role` alone).
    /// The caller must already have run `htp_s14_receiver::admit` on the bytes.
    pub(crate) async fn commit_seosmith_v4(
        &self,
        service_key: &str,
        body: &CommitV4<'_>,
        timeout: Duration,
    ) -> Result<Value, CommitV4Error> {
        let started = Instant::now();
        let diagnostic_id = Uuid::new_v4();
        // The caller passes what is left of the request budget (below the
        // producer's 30s), which can be under the RPC's own 20s
        // statement_timeout. Accepted (plan amendment, coordinator, 2026-11-25,
        // H3 recheck, N-MAJOR-2): H2 replay is idempotent and returns the stored
        // receipt before any state check, so a client timeout followed by a
        // producer retry resolves to that receipt. X measures commit p99.
        let response = self
            .client
            .post(format!(
                "{}/rpc/commit_seosmith_audit_v4",
                self.url.trim_end_matches("/websites")
            ))
            .header("apikey", service_key)
            .bearer_auth(service_key)
            .header("traceparent", ingest_traceparent(diagnostic_id))
            .timeout(timeout)
            .json(body)
            .send()
            .await
            .map_err(|error| {
                log_ingest_failure("worker-v4", diagnostic_id, started, &error);
                CommitV4Error::Unavailable
            })?;
        let status = response.status();
        if status.is_success() {
            return response
                .json()
                .await
                .map_err(|_| CommitV4Error::Unavailable);
        }
        let mut response = response;
        let mut buffer = Vec::new();
        while buffer.len() < 16 * 1024 {
            match response.chunk().await {
                Ok(Some(chunk)) => buffer.extend_from_slice(&chunk),
                _ => break,
            }
        }
        let error = commit_v4_error(&buffer);
        eprintln!(
            "seosmith worker-v4 diagnostic_id={diagnostic_id} upstream status={} class={error:?} elapsed_ms={}",
            status.as_u16(),
            started.elapsed().as_millis()
        );
        Err(error)
    }

    /// Cheap pre-admit credential check: does a binding exist for this token
    /// digest? Mirrors the lookup `commit_seosmith_audit_v4` does first. A
    /// disabled binding still counts as present, because H2 returns the receipt
    /// of an already committed delivery before looking at `enabled`; the RPC
    /// still decides everything else. The service key reads `seosmith_bindings`
    /// (revoked from every other role) and goes nowhere else.
    pub(crate) async fn seosmith_binding_exists(
        &self,
        service_key: &str,
        token_sha256: &str,
        timeout: Duration,
    ) -> Result<bool, CommitV4Error> {
        // The shared pooled client (no client, and no TLS handshake, per call).
        let response = self
            .client
            .get(format!(
                "{}/seosmith_bindings",
                self.url.trim_end_matches("/websites")
            ))
            .timeout(timeout)
            .header("apikey", service_key)
            .bearer_auth(service_key)
            .query(&[
                ("token_sha256", format!("eq.{token_sha256}")),
                ("select", "website_id".to_owned()),
                ("limit", "1".to_owned()),
            ])
            .send()
            .await
            .map_err(|error| {
                eprintln!(
                    "seosmith worker-v4 token lookup failed: {}",
                    error.without_url()
                );
                CommitV4Error::Unavailable
            })?;
        if !response.status().is_success() {
            eprintln!(
                "seosmith worker-v4 token lookup upstream status={}",
                response.status().as_u16()
            );
            return Err(CommitV4Error::Unavailable);
        }
        let rows: Vec<Value> = response
            .json()
            .await
            .map_err(|_| CommitV4Error::Unavailable)?;
        Ok(!rows.is_empty())
    }

    pub(crate) async fn find(
        &self,
        id: Uuid,
        headers: &HeaderMap,
    ) -> Result<Website, WebsiteError> {
        one(self
            .request(Method::GET, headers, &[("id", format!("eq.{id}"))], None)
            .await?)
    }

    /// Configure a trusted Supabase project and its publishable API key.
    ///
    /// # Panics
    /// If the shared HTTP client cannot be built (fails closed, never falls
    /// back to a redirect-following client).
    #[must_use]
    pub fn new(project_url: &str, publishable_key: &str) -> Self {
        Self {
            url: format!("{}/rest/v1/websites", project_url.trim_end_matches('/')),
            publishable_key: publishable_key.to_owned(),
            // Shared and pooled. No redirects: the schema-4 routes send the
            // service key in `apikey`, which reqwest does not strip on a hop.
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("the shared Supabase client must build; never fall back to a redirect-following one"),
        }
    }

    async fn request(
        &self,
        method: Method,
        headers: &HeaderMap,
        query: &[(&str, String)],
        body: Option<serde_json::Value>,
    ) -> Result<Vec<Website>, WebsiteError> {
        let authorization = headers
            .get(header::AUTHORIZATION)
            .ok_or(WebsiteError::Unauthorized)?;
        let mut request = self
            .client
            .request(method, &self.url)
            .header("apikey", &self.publishable_key)
            .header(header::AUTHORIZATION, authorization)
            .header("Prefer", "return=representation")
            .query(&[("select", "id,fqdn,ga4_property_id")])
            .query(query)
            .timeout(Duration::from_secs(10));
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|_| WebsiteError::Unavailable)?;
        match response.status() {
            StatusCode::UNAUTHORIZED => return Err(WebsiteError::Unauthorized),
            StatusCode::FORBIDDEN => return Err(WebsiteError::Forbidden),
            StatusCode::CONFLICT => return Err(WebsiteError::Conflict),
            status if !status.is_success() => return Err(WebsiteError::Unavailable),
            _ => {}
        }
        response.json().await.map_err(|_| WebsiteError::Unavailable)
    }
}

pub(crate) fn saved_response(mut body: Value, sync: &Value) -> Response {
    if body.is_null() {
        return (StatusCode::ACCEPTED, Json(json!({"code":"report_pending","error":"The first sync is queued. Saved data will appear shortly.","sync":sync}))).into_response();
    }
    body["sync"] = sync.clone();
    Json(body).into_response()
}

pub(crate) fn router(store: WebsiteStore) -> Router {
    Router::new()
        .route("/websites", get(list).post(create))
        .route("/websites/{id}", get(read).patch(update).delete(delete))
        .route(
            "/websites/{id}/analytics/property",
            axum::routing::put(set_property),
        )
        .with_state(store)
}

#[derive(Default, Deserialize)]
struct Pagination {
    limit: Option<usize>,
    offset: Option<usize>,
}

async fn list(
    State(store): State<WebsiteStore>,
    headers: HeaderMap,
    Query(page): Query<Pagination>,
) -> Result<Json<WebsitePage>, WebsiteError> {
    Ok(Json(
        store
            .list_saved(&headers, page.limit.unwrap_or(50), page.offset.unwrap_or(0))
            .await?,
    ))
}

async fn create(
    State(store): State<WebsiteStore>,
    headers: HeaderMap,
    Json(input): Json<WebsiteInput>,
) -> Result<(StatusCode, Json<Website>), WebsiteError> {
    let fqdn = normalize_fqdn(&input.fqdn).map_err(WebsiteError::Invalid)?;
    let rows = store
        .request(Method::POST, &headers, &[], Some(json!({ "fqdn": fqdn })))
        .await?;
    Ok((StatusCode::CREATED, Json(one(rows)?)))
}

async fn read(
    State(store): State<WebsiteStore>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Website>, WebsiteError> {
    let rows = store
        .request(Method::GET, &headers, &[("id", format!("eq.{id}"))], None)
        .await?;
    Ok(Json(one(rows)?))
}

async fn update(
    State(store): State<WebsiteStore>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<WebsiteInput>,
) -> Result<Json<Website>, WebsiteError> {
    let fqdn = normalize_fqdn(&input.fqdn).map_err(WebsiteError::Invalid)?;
    let rows = store
        .request(
            Method::PATCH,
            &headers,
            &[("id", format!("eq.{id}"))],
            Some(json!({ "fqdn": fqdn })),
        )
        .await?;
    Ok(Json(one(rows)?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PropertyInput {
    property_id: Option<String>,
}

async fn set_property(
    State(store): State<WebsiteStore>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<PropertyInput>,
) -> Result<Json<Website>, WebsiteError> {
    if input.property_id.as_ref().is_some_and(|id| {
        id.is_empty()
            || id.len() > 20
            || id.starts_with('0')
            || !id.bytes().all(|b| b.is_ascii_digit())
    }) {
        return Err(WebsiteError::Invalid("Enter a numeric GA4 property ID."));
    }
    let rows = store
        .request(
            Method::PATCH,
            &headers,
            &[("id", format!("eq.{id}"))],
            Some(json!({"ga4_property_id":input.property_id})),
        )
        .await?;
    Ok(Json(one(rows)?))
}

async fn delete(
    State(store): State<WebsiteStore>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<StatusCode, WebsiteError> {
    let rows = store
        .request(
            Method::DELETE,
            &headers,
            &[("id", format!("eq.{id}"))],
            None,
        )
        .await
        .map_err(|error| match error {
            WebsiteError::Conflict => WebsiteError::FormsPreventDeletion,
            other => other,
        })?;
    one(rows)?;
    Ok(StatusCode::NO_CONTENT)
}

fn one(rows: Vec<Website>) -> Result<Website, WebsiteError> {
    rows.into_iter().next().ok_or(WebsiteError::NotFound)
}

pub(crate) enum WebsiteError {
    GitHub(&'static str),
    Invalid(&'static str),
    Independent(StatusCode, &'static str),
    Unauthorized,
    Forbidden,
    Conflict,
    FormsPreventDeletion,
    NotFound,
    Unavailable,
}

impl IntoResponse for WebsiteError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Independent(status, message) => (status, message),
            Self::GitHub(message) => (StatusCode::BAD_GATEWAY, message),
            Self::Invalid(message) => (StatusCode::BAD_REQUEST, message),
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "Your session has ended. Sign in again.",
            ),
            Self::Forbidden => (
                StatusCode::FORBIDDEN,
                "You do not have access to this website.",
            ),
            Self::Conflict => (
                StatusCode::CONFLICT,
                "This domain is already in your websites.",
            ),
            Self::FormsPreventDeletion => (
                StatusCode::CONFLICT,
                "This website has retained form responses or independent audit evidence, or a form notification is sending. Export and remove retained records, or retry after delivery.",
            ),
            Self::NotFound => (StatusCode::NOT_FOUND, "Website not found."),
            Self::Unavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "Websites are temporarily unavailable. Please try again.",
            ),
        };
        (status, Json(json!({"error": message}))).into_response()
    }
}

/// Body of `commit_seosmith_audit_v4`. Borrowed so the report is serialised
/// once, with no intermediate `Value` copy.
// Field names are the RPC's parameter names.
#[derive(serde::Serialize)]
#[allow(clippy::struct_field_names)]
pub(crate) struct CommitV4<'a> {
    pub(crate) p_token: &'a str,
    pub(crate) p_delivery_id: Uuid,
    pub(crate) p_sha256: &'a str,
    pub(crate) p_report_json: &'a str,
    pub(crate) p_summary_text: &'a str,
    pub(crate) p_validator_revision: &'a str,
}

/// The H2 error contract, keyed on the exception message (never on the
/// SQLSTATE alone: `permission denied` and `s14_schema4_rows_exist` share
/// SQLSTATEs with documented codes but are operational faults).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CommitV4Error {
    ReportLimit,
    InvalidDelivery,
    InvalidWorker,
    DeliveryConflict,
    ValidatorDisabled,
    /// `evidence_invalid`, with the sanitised `invalid_evidence_*` detail.
    EvidenceInvalid(Option<String>),
    /// `invalid_s14_binding` / `invalid_s14_summary`.
    Binding,
    Unavailable,
}

fn commit_v4_error(body: &[u8]) -> CommitV4Error {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return CommitV4Error::Unavailable;
    };
    match value.get("message").and_then(Value::as_str) {
        Some("report_limit") => CommitV4Error::ReportLimit,
        Some("invalid_delivery" | "invalid_binding_or_report") => CommitV4Error::InvalidDelivery,
        Some("invalid_worker") => CommitV4Error::InvalidWorker,
        Some("delivery_conflict") => CommitV4Error::DeliveryConflict,
        Some("validator_disabled") => CommitV4Error::ValidatorDisabled,
        Some("invalid_s14_binding" | "invalid_s14_summary") => CommitV4Error::Binding,
        Some("evidence_invalid") => CommitV4Error::EvidenceInvalid(
            value
                .get("details")
                .and_then(Value::as_str)
                .filter(|d| {
                    d.len() <= 64
                        && d.starts_with("invalid_evidence_")
                        && d.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
                })
                .map(str::to_owned),
        ),
        _ => CommitV4Error::Unavailable,
    }
}

// The trace ID is server-generated and also appears in API diagnostics. Supabase
// documents traceparent in gateway logs, but downstream propagation is not guaranteed.
fn ingest_traceparent(id: Uuid) -> String {
    let span = Uuid::new_v4().simple().to_string();
    format!("00-{}-{}-01", id.simple(), &span[..16])
}

fn log_ingest_failure(path: &str, diagnostic_id: Uuid, started: Instant, error: &reqwest::Error) {
    let class = if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_decode() {
        "decode"
    } else if error.is_body() {
        "body"
    } else {
        "transport"
    };
    eprintln!(
        "seosmith {path} diagnostic_id={diagnostic_id} upstream error={class} elapsed_ms={}",
        started.elapsed().as_millis()
    );
}

// PostgREST error bodies may contain database detail or client data. Only emit a
// fixed label for the known SQLSTATE; never log the body, message, URL, or token.
async fn log_ingest_server_error(
    path: &str,
    diagnostic_id: Uuid,
    started: Instant,
    mut response: reqwest::Response,
) {
    const MAX_ERROR_BYTES: usize = 4096;
    let received = tokio::time::timeout(Duration::from_millis(250), async {
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            if chunk.len() > MAX_ERROR_BYTES - body.len() {
                return None;
            }
            body.extend_from_slice(&chunk);
        }
        Some(body)
    })
    .await
    .ok()
    .flatten();
    let class = received
        .as_deref()
        .and_then(postgrest_error_class)
        .unwrap_or("other_or_unavailable");
    eprintln!(
        "seosmith {path} diagnostic_id={diagnostic_id} upstream status=500 database_code={class} elapsed_ms={}",
        started.elapsed().as_millis()
    );
}

fn postgrest_error_class(body: &[u8]) -> Option<&'static str> {
    let value: Value = serde_json::from_slice(body).ok()?;
    match value.get("code").and_then(Value::as_str) {
        Some("57014") => Some("57014"),
        _ => None,
    }
}

#[cfg(test)]
mod ingest_error_tests {
    use super::postgrest_error_class;
    #[tokio::test]
    async fn diagnostic_does_not_wait_for_slow_error_body() {
        use axum::{Router, body::Body, http::StatusCode, routing::get};
        use futures_util::{StreamExt, stream};
        use std::{
            io,
            time::{Duration, Instant},
        };
        let app = Router::new().route(
            "/",
            get(|| async {
                let body = Body::from_stream(
                    stream::iter(vec![Ok::<_, io::Error>(&b"{"[..]), Ok(&b"}"[..])])
                        .enumerate()
                        .then(|(index, chunk)| async move {
                            if index == 1 {
                                tokio::time::sleep(Duration::from_secs(2)).await;
                            }
                            chunk
                        }),
                );
                (StatusCode::INTERNAL_SERVER_ERROR, body)
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let response = reqwest::get(url).await.unwrap();
        let started = Instant::now();
        super::log_ingest_server_error("worker", uuid::Uuid::new_v4(), started, response).await;
        assert!(started.elapsed() < Duration::from_secs(1));
        server.abort();
    }

    #[tokio::test]
    async fn deletion_conflict_explains_saved_form_responses() {
        use axum::{
            Router,
            extract::{Path, State},
            http::{HeaderMap, StatusCode},
            response::IntoResponse,
            routing::delete,
        };
        let app = Router::new().route(
            "/rest/v1/websites",
            delete(|| async { StatusCode::CONFLICT }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer test".parse().unwrap(),
        );
        let result = super::delete(
            State(super::WebsiteStore::new(&url, "test")),
            Path(uuid::Uuid::new_v4()),
            headers,
        )
        .await;
        let response = match result {
            Ok(_) => panic!("delete unexpectedly succeeded"),
            Err(error) => error.into_response(),
        };
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        assert!(
            String::from_utf8_lossy(&body)
                .contains("retained form responses or independent audit evidence")
        );
        server.abort();
    }

    #[test]
    fn ingest_rpc_deadline_stays_above_the_database_budget() {
        use std::time::Duration;
        assert_eq!(
            super::rpc_deadline("import_seosmith_audit"),
            Duration::from_secs(25)
        );
        assert_eq!(
            super::rpc_deadline("request_google_report"),
            Duration::from_secs(10)
        );
        assert_eq!(
            super::rpc_deadline("seosmith_audit_history"),
            Duration::from_secs(10)
        );
    }

    #[test]
    fn only_explicitly_allowlisted_database_codes_are_reported() {
        assert_eq!(
            postgrest_error_class(br#"{"code":"57014","message":"private"}"#),
            Some("57014")
        );
        assert_eq!(postgrest_error_class(br#"{"code":"private"}"#), None);
        assert_eq!(postgrest_error_class(b"not json"), None);
    }
}
