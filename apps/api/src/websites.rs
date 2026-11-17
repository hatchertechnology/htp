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

/// User-scoped access to Supabase; no privileged database credential is used.
#[derive(Clone)]
pub struct WebsiteStore {
    url: String,
    publishable_key: String,
    client: reqwest::Client,
}

impl WebsiteStore {
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
        let response = self
            .client
            .post(format!(
                "{}/rpc/{name}",
                self.url.trim_end_matches("/websites")
            ))
            .header("apikey", &self.publishable_key)
            .header(header::AUTHORIZATION, authorization)
            .timeout(Duration::from_secs(10))
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                if name == "import_seosmith_audit" {
                    log_ingest_failure("owner", started, &error);
                }
                WebsiteError::Unavailable
            })?;
        if name == "import_seosmith_audit" && !response.status().is_success() {
            eprintln!(
                "seosmith owner upstream status={} elapsed_ms={}",
                response.status().as_u16(),
                started.elapsed().as_millis()
            );
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
        response.json().await.map_err(|error| {
            if name == "import_seosmith_audit" {
                log_ingest_failure("owner", started, &error);
            }
            WebsiteError::Unavailable
        })
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
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| WebsiteError::Unavailable)?;
        let started = Instant::now();
        let response = client
            .post(format!(
                "{}/rpc/ingest_seosmith_audit",
                self.url.trim_end_matches("/websites")
            ))
            .header("apikey", &self.publishable_key)
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                log_ingest_failure("worker", started, &error);
                WebsiteError::Unavailable
            })?;
        if !response.status().is_success() {
            eprintln!(
                "seosmith worker upstream status={} elapsed_ms={}",
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
        response.json().await.map_err(|error| {
            log_ingest_failure("worker", started, &error);
            WebsiteError::Unavailable
        })
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
    #[must_use]
    pub fn new(project_url: &str, publishable_key: &str) -> Self {
        Self {
            url: format!("{}/rest/v1/websites", project_url.trim_end_matches('/')),
            publishable_key: publishable_key.to_owned(),
            client: reqwest::Client::new(),
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
        .await?;
    one(rows)?;
    Ok(StatusCode::NO_CONTENT)
}

fn one(rows: Vec<Website>) -> Result<Website, WebsiteError> {
    rows.into_iter().next().ok_or(WebsiteError::NotFound)
}

pub(crate) enum WebsiteError {
    GitHub(&'static str),
    Invalid(&'static str),
    Unauthorized,
    Forbidden,
    Conflict,
    NotFound,
    Unavailable,
}

impl IntoResponse for WebsiteError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
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
            Self::NotFound => (StatusCode::NOT_FOUND, "Website not found."),
            Self::Unavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "Websites are temporarily unavailable. Please try again.",
            ),
        };
        (status, Json(json!({"error": message}))).into_response()
    }
}

fn log_ingest_failure(path: &str, started: Instant, error: &reqwest::Error) {
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
        "seosmith {path} upstream error={class} elapsed_ms={}",
        started.elapsed().as_millis()
    );
}
