//! On-demand GA4 reports using the caller's short-lived Google OAuth token.

use std::time::Duration;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use htp_shared::analytics::{AnalyticsReport, AnalyticsRequest};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::websites::WebsiteStore;

/// Trusted upstream configuration. Never accept a Google API URL from a request.
#[derive(Clone)]
pub struct AnalyticsClient {
    endpoint: String,
    client: reqwest::Client,
}

impl Default for AnalyticsClient {
    fn default() -> Self {
        Self::new("https://analyticsdata.googleapis.com")
    }
}

impl AnalyticsClient {
    /// Configure the Google origin (or a trusted local test server).
    ///
    /// # Panics
    /// Panics if the TLS HTTP client cannot be initialized.
    #[must_use]
    pub fn new(endpoint: &str) -> Self {
        Self {
            endpoint: endpoint.trim_end_matches('/').into(),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("HTTP client configuration"),
        }
    }

    async fn report(
        &self,
        token: &str,
        fqdn: &str,
        input: &AnalyticsRequest,
    ) -> Result<Value, AnalyticsError> {
        let response = self.client
            .post(format!("{}/v1beta/properties/{}:runReport", self.endpoint, input.property_id))
            .bearer_auth(token)
            .timeout(Duration::from_secs(20))
            .json(&json!({
                "dateRanges": [{"startDate": input.start_date.to_string(), "endDate": input.end_date.to_string()}],
                "dimensions": [{"name": "date"}],
                "metrics": [{"name": "activeUsers"}, {"name": "sessions"}, {"name": "screenPageViews"}],
                "dimensionFilter": {"filter": {"fieldName": "hostName", "stringFilter": {"matchType": "EXACT", "value": fqdn, "caseSensitive": false}}},
                "orderBys": [{"dimension": {"dimensionName": "date"}}],
                "limit": "366"
            }))
            .send().await.map_err(|_| AnalyticsError::Upstream)?;
        let report = decode_google(response).await?;
        if !report.get("dimensionHeaders").is_some_and(Value::is_array)
            || !report.get("metricHeaders").is_some_and(Value::is_array)
        {
            return Err(AnalyticsError::Upstream);
        }
        Ok(report)
    }
}

async fn decode_google(response: reqwest::Response) -> Result<Value, AnalyticsError> {
    match response.status() {
        StatusCode::UNAUTHORIZED => return Err(AnalyticsError::GoogleToken),
        StatusCode::FORBIDDEN => return Err(AnalyticsError::Denied),
        StatusCode::TOO_MANY_REQUESTS => return Err(AnalyticsError::Quota),
        StatusCode::BAD_REQUEST | StatusCode::NOT_FOUND => {
            return Err(AnalyticsError::Property);
        }
        status if !status.is_success() => return Err(AnalyticsError::Upstream),
        _ => {}
    }
    response.json().await.map_err(|_| AnalyticsError::Upstream)
}

pub(crate) fn router(websites: WebsiteStore, google: AnalyticsClient) -> Router {
    Router::new()
        .route("/websites/{id}/analytics", post(report))
        .route("/websites/{id}/analytics/dashboard", post(dashboard))
        .with_state((websites, google))
}

async fn dashboard(
    State((websites, _google)): State<(WebsiteStore, AnalyticsClient)>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<AnalyticsRequest>,
) -> Result<Response, AnalyticsError> {
    input.validate().map_err(AnalyticsError::Invalid)?;
    let website = websites
        .find(id, &headers)
        .await
        .map_err(AnalyticsError::Website)?;
    if website.ga4_property_id.as_deref() != Some(input.property_id.as_str()) {
        return Err(AnalyticsError::Invalid(
            "Save this website's GA4 property before loading its dashboard.",
        ));
    }
    let saved = websites
        .saved_report(
            &headers,
            id,
            "analytics",
            &input.property_id,
            &input.start_date.to_string(),
            &input.end_date.to_string(),
        )
        .await
        .map_err(AnalyticsError::Website)?;
    let body = if saved["data"].is_null() {
        Value::Null
    } else {
        json!({"website":website,"property_id":input.property_id,"start_date":input.start_date,"end_date":input.end_date,"report":saved["data"]})
    };
    Ok(crate::websites::saved_response(body, &saved["sync"]))
}

fn google_token(headers: &HeaderMap) -> Result<&str, AnalyticsError> {
    let tokens = headers.get_all("x-google-access-token");
    if tokens.iter().count() != 1 {
        return Err(AnalyticsError::GoogleToken);
    }
    tokens
        .iter()
        .next()
        .and_then(|t| t.to_str().ok())
        .filter(|t| !t.is_empty() && t.len() <= 8192 && t.bytes().all(|b| b.is_ascii_graphic()))
        .ok_or(AnalyticsError::GoogleToken)
}

async fn report(
    State((websites, google)): State<(WebsiteStore, AnalyticsClient)>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<AnalyticsRequest>,
) -> Result<Json<AnalyticsReport>, AnalyticsError> {
    input.validate().map_err(AnalyticsError::Invalid)?;
    // RLS checks the caller's ownership before any request to Google.
    let website = websites
        .find(id, &headers)
        .await
        .map_err(AnalyticsError::Website)?;
    let token = google_token(&headers)?;
    let report = google.report(token, &website.fqdn, &input).await?;
    Ok(Json(AnalyticsReport {
        website,
        property_id: input.property_id,
        start_date: input.start_date,
        end_date: input.end_date,
        report,
    }))
}

enum AnalyticsError {
    Invalid(&'static str),
    Website(crate::websites::WebsiteError),
    GoogleToken,
    Denied,
    Quota,
    Property,
    Upstream,
}
impl IntoResponse for AnalyticsError {
    fn into_response(self) -> Response {
        let (status, error, code) = match self {
            Self::Website(error) => return error.into_response(),
            Self::Invalid(error) => (StatusCode::BAD_REQUEST, error, "invalid_analytics_request"),
            Self::GoogleToken => (
                StatusCode::UNAUTHORIZED,
                "Google authorization is missing or expired. Run analytics login again.",
                "google_authorization_required",
            ),
            Self::Denied => (
                StatusCode::FORBIDDEN,
                "Google denied access. Check property access, the analytics.readonly scope, and whether the Data API is enabled.",
                "google_access_denied",
            ),
            Self::Quota => (
                StatusCode::TOO_MANY_REQUESTS,
                "Google Analytics quota exceeded. Try again later.",
                "google_quota_exceeded",
            ),
            Self::Property => (
                StatusCode::BAD_REQUEST,
                "Google rejected the property or report request. Check the GA4 property ID and dates.",
                "google_report_rejected",
            ),
            Self::Upstream => (
                StatusCode::BAD_GATEWAY,
                "Google Analytics is temporarily unavailable.",
                "google_unavailable",
            ),
        };
        (status, Json(json!({"error":error,"code":code}))).into_response()
    }
}
