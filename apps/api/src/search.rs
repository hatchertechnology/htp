//! Website-scoped read-only Search Console and URL Inspection connections.
use crate::websites::WebsiteStore;
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;
use uuid::Uuid;

#[derive(Clone)]
pub struct SearchClient {
    inspection: String,
    client: reqwest::Client,
}
impl Default for SearchClient {
    fn default() -> Self {
        Self::new(
            "https://www.googleapis.com",
            "https://searchconsole.googleapis.com",
        )
    }
}
impl SearchClient {
    /// Origins are trusted configuration, never caller input.
    ///
    /// # Panics
    /// Panics if the TLS HTTP client cannot be initialized.
    #[must_use]
    pub fn new(_search: &str, inspection: &str) -> Self {
        Self {
            inspection: inspection.trim_end_matches('/').into(),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(25))
                .build()
                .expect("HTTP client configuration"),
        }
    }
    async fn send(
        &self,
        token: &str,
        method: reqwest::Method,
        url: reqwest::Url,
        body: Option<Value>,
    ) -> Result<Value, SearchError> {
        let mut request = self.client.request(method, url).bearer_auth(token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|_| SearchError::Upstream)?;
        let status = response.status();
        let value: Value = response.json().await.map_err(|_| SearchError::Upstream)?;
        if !status.is_success() {
            // Google also uses 403 for quota exhaustion; never relay upstream bodies/tokens.
            let quota = value
                .pointer("/error/errors")
                .and_then(Value::as_array)
                .is_some_and(|errors| {
                    errors.iter().any(|e| {
                        matches!(
                            e["reason"].as_str(),
                            Some(
                                "quotaExceeded"
                                    | "dailyLimitExceeded"
                                    | "rateLimitExceeded"
                                    | "userRateLimitExceeded"
                            )
                        )
                    })
                });
            return Err(if quota || status == StatusCode::TOO_MANY_REQUESTS {
                SearchError::Quota
            } else {
                match status {
                    StatusCode::UNAUTHORIZED => SearchError::Token,
                    StatusCode::FORBIDDEN => SearchError::Denied,
                    StatusCode::NOT_FOUND => SearchError::Missing,
                    StatusCode::BAD_REQUEST => SearchError::Invalid(
                        "Google rejected this request. Check the property, URL, and API configuration.",
                    ),
                    _ => SearchError::Upstream,
                }
            });
        }
        if !value.is_object() {
            return Err(SearchError::Upstream);
        }
        Ok(value)
    }
}
fn url(origin: &str, path: &str) -> Result<reqwest::Url, SearchError> {
    reqwest::Url::parse(&format!("{origin}{path}")).map_err(|_| SearchError::Upstream)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchInput {
    site_url: String,
    start_date: String,
    end_date: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UrlInput {
    site_url: String,
    url: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

/// Properties must represent this exact website, not another user-entered host.
fn valid_property(site: &str, fqdn: &str) -> bool {
    if let Some(domain) = site.strip_prefix("sc-domain:") {
        return htp_shared::normalize_fqdn(domain).is_ok_and(|normalized| normalized == domain)
            && (domain == fqdn || fqdn.ends_with(&format!(".{domain}")));
    }
    reqwest::Url::parse(site).is_ok_and(|u| {
        matches!(u.scheme(), "http" | "https")
            && u.host_str() == Some(fqdn)
            && u.username().is_empty()
            && u.password().is_none()
            && u.port().is_none()
            && u.query().is_none()
            && u.fragment().is_none()
            && site.ends_with('/')
    })
}
fn normalized_inspection(value: &str, site: &str, fqdn: &str) -> Option<(String, String)> {
    if value.len() > 2048 || site.len() > 2048 || !valid_property(site, fqdn) {
        return None;
    }
    // Use the same parsed representation for provider requests, persistence and
    // history keys. URL parsing lowercases hosts and removes default ports.
    let site = if site.starts_with("sc-domain:") {
        site.to_owned()
    } else {
        reqwest::Url::parse(site).ok()?.to_string()
    };
    let u = reqwest::Url::parse(value).ok()?;
    (matches!(u.scheme(), "http" | "https")
        && u.host_str() == Some(fqdn)
        && u.username().is_empty()
        && u.password().is_none()
        && u.port().is_none()
        && u.fragment().is_none()
        && (site.starts_with("sc-domain:") || u.as_str().starts_with(&site)))
    .then(|| (u.to_string(), site))
}
#[cfg(test)]
fn valid_url(value: &str, site: &str, fqdn: &str) -> bool {
    normalized_inspection(value, site, fqdn).is_some()
}
fn token(headers: &HeaderMap) -> Result<&str, SearchError> {
    let values = headers.get_all("x-google-access-token");
    if values.iter().count() != 1 {
        return Err(SearchError::Token);
    }
    values
        .iter()
        .next()
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty() && v.len() <= 8192 && v.bytes().all(|b| b.is_ascii_graphic()))
        .ok_or(SearchError::Token)
}
pub(crate) fn router(store: WebsiteStore, client: SearchClient) -> Router {
    Router::new()
        .route("/websites/{id}/search/properties", post(properties))
        .route("/websites/{id}/search/dashboard", post(dashboard))
        .route("/websites/{id}/search/inspect", post(inspect))
        .route(
            "/websites/{id}/search/inspection-history",
            post(inspection_history),
        )
        .with_state((store, client))
}
async fn properties(
    State((store, _google)): State<(WebsiteStore, SearchClient)>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(_): Json<Empty>,
) -> Result<Response, SearchError> {
    store
        .find(id, &headers)
        .await
        .map_err(SearchError::Website)?;
    let saved = store
        .saved_report(&headers, id, "properties", "", "1970-01-01", "1970-01-01")
        .await
        .map_err(SearchError::Website)?;
    Ok(crate::websites::saved_response(
        saved["data"].clone(),
        &saved["sync"],
    ))
}
async fn dashboard(
    State((store, _google)): State<(WebsiteStore, SearchClient)>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<SearchInput>,
) -> Result<Response, SearchError> {
    // Reuse the existing strict real-date / inclusive 366-day contract.
    let dates: htp_shared::analytics::AnalyticsRequest = serde_json::from_value(
        json!({"property_id":"1","start_date":input.start_date,"end_date":input.end_date}),
    )
    .map_err(|_| SearchError::Invalid("Use real dates in YYYY-MM-DD format."))?;
    dates.validate().map_err(SearchError::Invalid)?;
    let website = store
        .find(id, &headers)
        .await
        .map_err(SearchError::Website)?;
    if !valid_property(&input.site_url, &website.fqdn) {
        return Err(SearchError::Invalid(
            "Choose a Search Console property for this website.",
        ));
    }
    let saved = store
        .saved_report(
            &headers,
            id,
            "search",
            &input.site_url,
            &input.start_date,
            &input.end_date,
        )
        .await
        .map_err(SearchError::Website)?;
    Ok(crate::websites::saved_response(
        saved["data"].clone(),
        &saved["sync"],
    ))
}
async fn inspect(
    State((store, google)): State<(WebsiteStore, SearchClient)>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<UrlInput>,
) -> Result<Json<Value>, SearchError> {
    let website = store
        .find(id, &headers)
        .await
        .map_err(SearchError::Website)?;
    let (inspection_url, site_url) =
        normalized_inspection(&input.url, &input.site_url, &website.fqdn).ok_or(
            SearchError::Invalid(
                "Enter a URL on this website within the selected property, without a fragment.",
            ),
        )?;
    let data = google
        .send(
            token(&headers)?,
            reqwest::Method::POST,
            url(&google.inspection, "/v1/urlInspection/index:inspect")?,
            Some(json!({"inspectionUrl":inspection_url,"siteUrl":site_url,"languageCode":"en-US"})),
        )
        .await?;
    if !data["inspectionResult"].is_object() {
        return Err(SearchError::Upstream);
    }
    let saved = store
        .rpc(
            &headers,
            "save_search_inspection",
            json!({
                "p_website_id": id, "p_fqdn": website.fqdn,
                "p_site_url": site_url, "p_url": inspection_url, "p_data": data
            }),
        )
        .await
        .map_err(SearchError::Website)?;
    let mut result = data;
    result["saved_observation"] = saved;
    Ok(Json(result))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InspectionHistoryInput {
    site_url: String,
    url: String,
    before_id: Option<i64>,
}
async fn inspection_history(
    State((store, _)): State<(WebsiteStore, SearchClient)>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<InspectionHistoryInput>,
) -> Result<Json<Value>, SearchError> {
    let website = store
        .find(id, &headers)
        .await
        .map_err(SearchError::Website)?;
    let (inspection_url, site_url) =
        normalized_inspection(&input.url, &input.site_url, &website.fqdn).ok_or(
            SearchError::Invalid("Choose a URL within this website and a valid history cursor."),
        )?;
    if input.before_id.is_some_and(|id| id <= 0) {
        return Err(SearchError::Invalid(
            "Choose a URL within this website and a valid history cursor.",
        ));
    }
    store
        .rpc(
            &headers,
            "search_inspection_history",
            json!({
                "p_website_id": id, "p_site_url": site_url,
                "p_url": inspection_url, "p_before_id": input.before_id
            }),
        )
        .await
        .map(Json)
        .map_err(SearchError::Website)
}
enum SearchError {
    Invalid(&'static str),
    Website(crate::websites::WebsiteError),
    Token,
    Denied,
    Quota,
    Missing,
    Upstream,
}
impl IntoResponse for SearchError {
    fn into_response(self) -> Response {
        let (status, code, error) = match self {
            Self::Website(e) => return e.into_response(),
            Self::Invalid(e) => (StatusCode::BAD_REQUEST, "invalid_search_request", e),
            Self::Token => (
                StatusCode::UNAUTHORIZED,
                "google_authorization_required",
                "Reconnect Google to authorize this service.",
            ),
            Self::Denied => (
                StatusCode::FORBIDDEN,
                "google_access_denied",
                "Google denied access. Check property permissions, granted scopes, and that this API is enabled in the OAuth project's Google Cloud console.",
            ),
            Self::Quota => (
                StatusCode::TOO_MANY_REQUESTS,
                "google_quota_exceeded",
                "Google quota exceeded. Wait before trying again.",
            ),
            Self::Missing => (
                StatusCode::NOT_FOUND,
                "google_not_found",
                "Google could not find the property or URL. Check Search Console access and the URL.",
            ),
            Self::Upstream => (
                StatusCode::BAD_GATEWAY,
                "google_unavailable",
                "Google Search is temporarily unavailable. Try again.",
            ),
        };
        (status, Json(json!({"error":error,"code":code}))).into_response()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn property_and_url_boundaries() {
        assert!(valid_property("sc-domain:example.com", "www.example.com"));
        assert!(!valid_property("sc-domain:example.com", "notexample.com"));
        for site in [
            "sc-domain:example.com",
            "https://example.com/",
            "https://example.com/jobs/",
        ] {
            assert!(valid_property(site, "example.com"));
        }
        for site in [
            "sc-domain:other.com",
            "sc-domain:com",
            "https://example.com.evil.com/",
            "https://user@example.com/",
            "https://example.com/?x=/",
            "ftp://example.com/",
            "https://example.com",
        ] {
            assert!(!valid_property(site, "example.com"));
        }
        assert!(valid_url(
            "https://example.com/jobs/1?a=b",
            "https://example.com/jobs/",
            "example.com"
        ));
        for value in [
            "https://example.com/jobs/../admin",
            "https://example.com/jobsevil/1",
            "https://sub.example.com/jobs/1",
            "https://example.com/jobs/1#x",
            "https://other.com/jobs/1",
        ] {
            assert!(!valid_url(
                value,
                "https://example.com/jobs/",
                "example.com"
            ));
        }
    }
    #[test]
    fn token_headers_are_unambiguous() {
        let mut headers = HeaderMap::new();
        assert!(token(&headers).is_err());
        headers.insert("x-google-access-token", "valid-token".parse().unwrap());
        assert_eq!(token(&headers).ok(), Some("valid-token"));
        headers.append("x-google-access-token", "another".parse().unwrap());
        assert!(token(&headers).is_err());
    }
    async fn mock_upstream() -> (
        String,
        tokio::task::JoinHandle<()>,
        std::sync::Arc<std::sync::Mutex<Vec<(String, String, Value)>>>,
    ) {
        use axum::{extract::OriginalUri, http::Method, routing::any};
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let capture = seen.clone();
        let app = Router::new().fallback(any(move |method: Method, uri: OriginalUri, headers: HeaderMap, body: axum::body::Bytes| {
            let capture = capture.clone();
            async move {
                let input: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                capture.lock().unwrap().push((method.to_string(), uri.to_string(), input.clone()));
                if uri.path() == "/rest/v1/websites" {
                    assert_eq!(headers["authorization"], "Bearer owner-token");
                    if headers.get("x-test-no-website").is_some() { return Json(json!([])); }
                    return Json(json!([{"id":"a19a3adb-148d-4714-9278-c2d709fe0ad1","fqdn":"example.com"}]));
                }
                if uri.path() == "/rest/v1/rpc/request_google_report" {
                    assert_eq!(headers["authorization"], "Bearer owner-token");
                    if input["p_kind"] == "properties" { return Json(json!({"data":{"properties":[{"siteUrl":"sc-domain:example.com","permissionLevel":"siteOwner"}]},"sync":{"state":"ready"}})); }
                    return Json(json!({"data":{"site_url":input["p_property_id"],"summary":{"rows":[{"clicks":12}]},"daily":{},"queries":{},"pages":{}},"sync":{"state":"ready"}}));
                }
                if uri.path() == "/rest/v1/rpc/save_search_inspection" {
                    assert_eq!(headers["authorization"], "Bearer owner-token");
                    assert!(headers.get("x-google-access-token").is_none());
                    return Json(json!({"id":1,"observed_at":"2026-11-01T00:00:00Z"}));
                }
                if uri.path() == "/rest/v1/rpc/search_inspection_history" {
                    assert_eq!(headers["authorization"], "Bearer owner-token");
                    return Json(json!({"observations":[],"has_more":false}));
                }
                assert_eq!(headers["authorization"], "Bearer google-token");
                if uri.path().ends_with("/sites") { return Json(json!({"siteEntry":[{"siteUrl":"sc-domain:example.com","permissionLevel":"siteOwner"},{"siteUrl":"https://other.com/","permissionLevel":"siteOwner"},{"siteUrl":"https://example.com/","permissionLevel":"siteUnverifiedUser"}]})); }
                if uri.path().ends_with("/query") { return Json(json!({"rows":[{"clicks":12,"impressions":100,"ctr":0.12,"position":3.5}]})); }
                if uri.path().ends_with(":inspect") { return Json(json!({"inspectionResult":{"indexStatusResult":{"verdict":"PASS"}}})); }
                panic!("Unexpected Google API endpoint")
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (origin, server, seen)
    }
    async fn call(app: Router, path: &str, input: Value) -> axum::response::Response {
        use tower::ServiceExt;
        app.oneshot(
            axum::http::Request::post(format!(
                "/websites/a19a3adb-148d-4714-9278-c2d709fe0ad1/search/{path}"
            ))
            .header("authorization", "Bearer owner-token")
            .header("x-google-access-token", "google-token")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(input.to_string()))
            .unwrap(),
        )
        .await
        .unwrap()
    }
    #[tokio::test]
    async fn connections_use_official_contracts_and_reject_other_hosts() {
        let (origin, server, seen) = mock_upstream().await;
        let app = router(
            WebsiteStore::new(&origin, "public-key"),
            SearchClient::new(&origin, &origin),
        );
        let response = call(app.clone(), "properties", json!({})).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 8192)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(body["properties"].as_array().unwrap().len(), 1);
        assert_eq!(call(app.clone(), "dashboard", json!({"site_url":"sc-domain:example.com","start_date":"2026-10-01","end_date":"2026-10-27"})).await.status(), StatusCode::OK);
        let base = json!({"site_url":"sc-domain:example.com","url":"https://example.com/jobs/1"});
        assert_eq!(
            call(app.clone(), "inspect", base.clone()).await.status(),
            StatusCode::OK
        );
        assert_eq!(
            call(app.clone(), "inspection-history", base.clone())
                .await
                .status(),
            StatusCode::OK
        );
        let normalized = json!({"site_url":"https://EXAMPLE.com:443/jobs/", "url":"https://EXAMPLE.com:443/jobs/1"});
        assert_eq!(
            call(app.clone(), "inspect", normalized.clone())
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            call(app.clone(), "inspection-history", normalized)
                .await
                .status(),
            StatusCode::OK
        );
        let mut other = base;
        other["url"] = json!("https://other.com/jobs/1");
        assert_eq!(
            call(app.clone(), "inspect", other).await.status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            call(app.clone(), "indexing", json!({})).await.status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(call(app.clone(), "dashboard", json!({"site_url":"sc-domain:example.com","start_date":"2026-02-30","end_date":"2026-10-27"})).await.status(), StatusCode::BAD_REQUEST);
        let requests = seen.lock().unwrap();
        let saved: Vec<_> = requests
            .iter()
            .filter(|r| r.1 == "/rest/v1/rpc/request_google_report")
            .collect();
        assert_eq!(saved.len(), 2);
        assert_eq!(saved[1].2["p_kind"], "search");
        assert_eq!(saved[1].2["p_property_id"], "sc-domain:example.com");
        assert!(
            !requests
                .iter()
                .any(|r| r.1.ends_with("/query") || r.1.ends_with("/sites"))
        );
        assert!(requests.iter().any(|r| r.0 == "POST"
            && r.1 == "/v1/urlInspection/index:inspect"
            && r.2["inspectionUrl"] == "https://example.com/jobs/1"));
        assert!(
            requests
                .iter()
                .any(|r| r.1 == "/rest/v1/rpc/save_search_inspection"
                    && r.2["p_fqdn"] == "example.com"
                    && r.2["p_data"]["inspectionResult"]["indexStatusResult"]["verdict"] == "PASS")
        );
        for path in [
            "/rest/v1/rpc/save_search_inspection",
            "/rest/v1/rpc/search_inspection_history",
        ] {
            assert!(requests.iter().any(|r| r.1 == path
                && r.2["p_site_url"] == "https://example.com/jobs/"
                && r.2["p_url"] == "https://example.com/jobs/1"));
        }
        assert!(
            requests
                .iter()
                .any(|r| r.1 == "/v1/urlInspection/index:inspect"
                    && r.2["siteUrl"] == "https://example.com/jobs/"
                    && r.2["inspectionUrl"] == "https://example.com/jobs/1")
        );
        server.abort();
    }
    #[tokio::test]
    async fn website_ownership_is_checked_before_google() {
        use axum::{body::Body, http::Request, routing::get};
        use tower::ServiceExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route("/rest/v1/websites", get(|| async { Json(json!([])) })),
            )
            .await
            .unwrap();
        });
        let app = router(
            WebsiteStore::new(&origin, "public"),
            SearchClient::new("http://127.0.0.1:1", "http://127.0.0.1:1"),
        );
        let response = app
            .oneshot(
                Request::post("/websites/a19a3adb-148d-4714-9278-c2d709fe0ad1/search/properties")
                    .header("authorization", "Bearer owner")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        server.abort();
    }
    #[tokio::test]
    async fn google_quota_errors_are_sanitized() {
        use axum::routing::get;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, Router::new().route("/quota", get(|| async { (StatusCode::FORBIDDEN, Json(json!({"error":{"message":"private provider detail", "errors":[{"reason":"dailyLimitExceeded"}]}}))) }))).await.unwrap();
        });
        let client = SearchClient::new(&origin, &origin);
        let result = client
            .send(
                "private-token",
                reqwest::Method::GET,
                reqwest::Url::parse(&format!("{origin}/quota")).unwrap(),
                None,
            )
            .await;
        assert!(matches!(result, Err(SearchError::Quota)));
        server.abort();
    }
}
