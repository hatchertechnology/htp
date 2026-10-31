//! Authenticated website persistence through Supabase's user-scoped Data API.

use std::time::Duration;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
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
        response.json().await.map_err(|_| WebsiteError::Unavailable)
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
