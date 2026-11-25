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
struct DatasetInput {
    site_url: String,
    start_date: String,
    end_date: String,
    dataset: String,
    offset: Option<usize>,
    limit: Option<usize>,
    device: Option<String>,
    country: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct UrlInput {
    pub(crate) site_url: String,
    pub(crate) url: String,
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
pub(crate) fn normalized_inspection(
    value: &str,
    site: &str,
    fqdn: &str,
) -> Option<(String, String)> {
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
    (u.as_str().len() <= 2048
        && site.len() <= 2048
        && matches!(u.scheme(), "http" | "https")
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
        .route("/websites/{id}/search/dataset", post(dataset))
        .route("/websites/{id}/search/crawl-evidence", post(crawl_evidence))
        .route("/websites/{id}/search/inspect", post(inspect))
        .route(
            "/websites/{id}/search/inspection-history",
            post(inspection_history),
        )
        .with_state((store, client))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CrawlEvidenceInput {
    delivery_id: Uuid,
    site_url: String,
    url: String,
    finding_after: Option<i32>,
    evaluation_after: Option<i32>,
    limit: Option<i32>,
}
async fn crawl_evidence(
    State((store, _)): State<(WebsiteStore, SearchClient)>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<CrawlEvidenceInput>,
) -> Result<Json<Value>, SearchError> {
    let website = store
        .find(id, &headers)
        .await
        .map_err(SearchError::Website)?;
    if !normalized_inspection(&input.url, &input.site_url, &website.fqdn)
        .is_some_and(|(url, _)| url == input.url)
        || input.finding_after.is_some_and(|n| n < -1)
        || input.evaluation_after.is_some_and(|n| n < -1)
        || input.limit.is_some_and(|n| !(1..=50).contains(&n))
    {
        return Err(SearchError::Invalid(
            "Choose an exact website URL, delivery and valid evidence cursor.",
        ));
    }
    let data = store.rpc(&headers, "search_crawl_evidence", json!({
        "p_website_id":id,"p_delivery_id":input.delivery_id,"p_url":input.url,
        "p_finding_after":input.finding_after.unwrap_or(-1),"p_evaluation_after":input.evaluation_after.unwrap_or(-1),"p_limit":input.limit.unwrap_or(25)
    })).await.map_err(SearchError::Website)?;
    Ok(Json(data))
}

async fn dataset(
    State((store, _)): State<(WebsiteStore, SearchClient)>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<DatasetInput>,
) -> Result<Json<Value>, SearchError> {
    let dates: htp_shared::analytics::AnalyticsRequest = serde_json::from_value(
        json!({"property_id":"1","start_date":input.start_date,"end_date":input.end_date}),
    )
    .map_err(|_| SearchError::Invalid("Use real dates in YYYY-MM-DD format."))?;
    dates.validate().map_err(SearchError::Invalid)?;
    let limit = input.limit.unwrap_or(50);
    let offset = input.offset.unwrap_or(0);
    if !(1..=100).contains(&limit)
        || offset > 5000
        || !matches!(
            input.dataset.as_str(),
            "queries"
                | "pages"
                | "query_pages"
                | "query_page_segments"
                | "devices"
                | "countries"
                | "analysis"
                | "landing_outcomes"
        )
    {
        return Err(SearchError::Invalid(
            "Choose a supported dataset and page (maximum 100 rows).",
        ));
    }
    if (input.device.is_some() || input.country.is_some()) && input.dataset != "query_page_segments"
        || input
            .device
            .as_deref()
            .is_some_and(|v| !matches!(v, "DESKTOP" | "MOBILE" | "TABLET"))
        || input
            .country
            .as_deref()
            .is_some_and(|v| v.len() != 3 || !v.bytes().all(|b| b.is_ascii_lowercase()))
    {
        return Err(SearchError::Invalid(
            "Choose a valid device and three-letter country code for segments.",
        ));
    }
    let website = store
        .find(id, &headers)
        .await
        .map_err(SearchError::Website)?;
    if !valid_property(&input.site_url, &website.fqdn) {
        return Err(SearchError::Invalid(
            "Choose a Search Console property for this website.",
        ));
    }
    let (kind, property) = if input.dataset == "landing_outcomes" {
        let Some(property) = website.ga4_property_id else {
            return Ok(Json(
                json!({"semantics_version":1,"dataset":"landing_outcomes","available":false,"reason":"ga4_property_unavailable","rows":[],"offset":offset,"limit":limit,"has_more":false}),
            ));
        };
        ("conversions", property)
    } else {
        ("search", input.site_url.clone())
    };
    // One bounded database read selects only the requested page plus the
    // collection, freshness and daily-sync metadata. The full snapshot is never
    // sent to this process, and the database re-checks ownership independently.
    let saved = store
        .rpc(
            &headers,
            "read_search_dataset_page",
            json!({
                "p_website_id":id,"p_kind":kind,"p_property_id":property,
                "p_start_date":input.start_date,"p_end_date":input.end_date,
                "p_dataset":input.dataset,"p_offset":offset,"p_limit":limit,
                "p_device":input.device,"p_country":input.country
            }),
        )
        .await
        .map_err(SearchError::Website)?;
    if input.dataset == "landing_outcomes" {
        return Ok(Json(landing_projection(&saved, offset, limit)));
    }

    if input.dataset == "query_page_segments" {
        return Ok(Json(segment_projection(
            &saved,
            input.device.as_deref(),
            input.country.as_deref(),
            offset,
            limit,
        )));
    }
    Ok(Json(dataset_projection(
        &saved,
        &input.dataset,
        offset,
        limit,
    )))
}

/// The database already selected and byte-bounded this page when it returns the
/// `page` metadata. Legacy and unit-test callers without it keep the in-process
/// slice, so the public dataset contract is unchanged either way.
fn bounded_page<'a>(
    saved: &'a Value,
    rows: &'a [Value],
    offset: usize,
    limit: usize,
) -> (&'a [Value], Option<usize>, bool) {
    if let Some(meta) = saved.get("page") {
        (
            rows,
            meta["retained_rows"]
                .as_u64()
                .and_then(|n| usize::try_from(n).ok()),
            meta["has_more"].as_bool().unwrap_or(false),
        )
    } else {
        let start = offset.min(rows.len());
        let end = start.saturating_add(limit).min(rows.len());
        (
            rows.get(start..end).unwrap_or(&[]),
            Some(rows.len()),
            offset.saturating_add(limit) < rows.len(),
        )
    }
}

fn segment_projection(
    saved: &Value,
    device: Option<&str>,
    country: Option<&str>,
    offset: usize,
    limit: usize,
) -> Value {
    let (filtered, invalid_rows) = if saved.get("page").is_some() {
        (
            saved.clone(),
            saved["page"]["invalid_rows_omitted"]
                .as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .unwrap_or(0),
        )
    } else {
        let mut filtered = saved.clone();
        let mut invalid_rows = 0;
        if let Some(rows) = filtered["data"]["query_page_segments"]["rows"].as_array_mut() {
            rows.retain(|row| {
                if !row["keys"]
                    .as_array()
                    .is_some_and(|keys| keys.len() == 4 && keys.iter().all(Value::is_string))
                {
                    invalid_rows += 1;
                    return false;
                }
                let keys = row["keys"].as_array();
                keys.is_some_and(|keys| {
                    keys.len() == 4
                        && keys.iter().all(Value::is_string)
                        && device.is_none_or(|v| keys[2].as_str() == Some(v))
                        && country.is_none_or(|v| keys[3].as_str() == Some(v))
                })
            });
        }
        (filtered, invalid_rows)
    };
    let mut result = dataset_projection(&filtered, "query_page_segments", offset, limit);
    result["filters"] = json!({"device":device,"country":country});
    result["filter_scope"] = json!("retained_bounded_rows_only");
    result["invalid_rows_omitted"] = json!(invalid_rows);
    result
}

fn landing_projection(saved: &Value, offset: usize, limit: usize) -> Value {
    let outcome = &saved["data"]["analysis"]["landing_outcomes"];
    let exact = saved["sync"]["exact_range_available"] == true;
    let rows = outcome["rows"].as_array();
    let available = exact && outcome["available"] == true && rows.is_some();
    let (page, total, has_more) = if let Some(rows) = rows.filter(|_| available) {
        bounded_page(saved, rows, offset, limit)
    } else {
        (&[][..], None, false)
    };
    let page: Vec<Value> = page.to_vec();
    json!({"semantics_version":1,"dataset":"landing_outcomes","available":available,
        "reason":if !exact { Some("exact_period_snapshot_unavailable") } else { outcome["reason"].as_str().or(if available { None } else { Some("landing_outcomes_unavailable") }) },
        "rows":page,"offset":offset,"limit":limit,"retained_rows":total,
        "has_more":has_more,
        "collection":outcome.get("collection"),"attribution":outcome.get("attribution"),
        "currency_code":saved["data"]["pages"]["metadata"].get("currencyCode"),
        "measurement":saved["data"].get("measurement"),"sync":saved["sync"],"daily_sync":saved["daily_sync"]})
}

fn dataset_projection(saved: &Value, name: &str, offset: usize, limit: usize) -> Value {
    let exact = saved["sync"]["exact_range_available"] == true;
    let dataset = &saved["data"][name];
    let rows = if name == "analysis" {
        dataset["candidates"].as_array()
    } else {
        dataset["rows"].as_array()
    };
    let available = exact && rows.is_some();
    let (page, total, has_more) = if let Some(rows) = rows.filter(|_| available) {
        bounded_page(saved, rows, offset, limit)
    } else {
        (&[][..], None, false)
    };
    let page: Vec<Value> = page.iter().cloned().map(|mut row| {
        if name == "analysis" && row.get("evidence_presentation").is_none() {
            // The database already trims evidence and records the retained and
            // returned counts for a bounded page; preserve that instead of
            // recounting truncated rows. Legacy/in-process callers have no
            // marker and keep the historical trim here.
            if let Some(evidence) = row.get_mut("evidence").and_then(Value::as_array_mut) {
                let count = evidence.len();
                evidence.truncate(25);
                row["evidence_presentation"] = json!({"retained_rows":count,"returned_rows":count.min(25),"truncated":count>25});
            }
        }
        row
    }).collect();
    json!({"semantics_version":1, "dataset":name, "available":available,
        "reason":if available { None } else if !exact { Some("exact_period_snapshot_unavailable") } else { dataset["reason"].as_str().or(Some("dataset_unavailable")) },
        "rows":page, "offset":offset, "limit":limit, "retained_rows":total,
        "has_more":has_more,
        "collection":if available { dataset.get("collection").cloned() } else { None },
        "comparison":if available && name == "analysis" { dataset.get("comparison").cloned() } else { None },
        "coverage":if available && name == "analysis" { dataset.get("coverage").cloned() } else { None },
        "policy":if available && name == "analysis" { dataset.get("policy").cloned() } else { None },
        "measurement":if available { saved["data"].get("measurement").cloned() } else { None },
        "sync":saved["sync"],"daily_sync":saved["daily_sync"]})
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
        dashboard_projection(&saved["data"]),
        &saved["sync"],
    ))
}
// Polling dashboards need small presentation datasets. Full immutable evidence
// remains available through the owner-scoped saved-data API/MCP snapshot reads.
fn dashboard_projection(data: &Value) -> Value {
    if !data.is_object() {
        return data.clone();
    }
    let mut projected = serde_json::Map::new();
    for key in [
        "site_url",
        "start_date",
        "end_date",
        "summary",
        "daily",
        "measurement",
    ] {
        if let Some(value) = data.get(key) {
            projected.insert(key.to_owned(), value.clone());
        }
    }
    for key in ["queries", "pages"] {
        if let Some(dataset) = data.get(key) {
            let mut dataset = dataset.clone();
            if let Some(rows) = dataset.get_mut("rows").and_then(Value::as_array_mut) {
                let returned = rows.len();
                rows.truncate(10);
                dataset["presentation"] = json!({"row_limit":10,"truncated":returned>10});
            }
            projected.insert(key.to_owned(), dataset);
        }
    }
    Value::Object(projected)
}
pub(crate) async fn inspect(
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
pub(crate) enum SearchError {
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
    fn inspection_lengths_apply_after_percent_encoding() {
        let expanded = format!("https://example.com/{}", "é".repeat(500));
        assert!(expanded.len() < 2048);
        assert!(normalized_inspection(&expanded, "sc-domain:example.com", "example.com").is_none());
        let property = format!("{expanded}/");
        assert!(
            normalized_inspection(&format!("{property}child"), &property, "example.com").is_none()
        );
        let boundary = format!("https://example.com/{}", "a".repeat(2028));
        assert_eq!(boundary.len(), 2048);
        assert!(normalized_inspection(&boundary, "sc-domain:example.com", "example.com").is_some());
        let permitted = format!("https://example.com/{}", "é".repeat(300));
        let (normalized, _) =
            normalized_inspection(&permitted, "sc-domain:example.com", "example.com").unwrap();
        assert!(normalized.len() <= 2048);
        assert!(normalized.contains("%C3%A9"));
    }
    #[test]
    fn dashboard_polling_projects_only_bounded_presentation_rows() {
        let data = json!({"site_url":"sc-domain:example.com", "summary":{"rows":[{"clicks":1}]},
            "daily":{"rows":[]},"queries":{"rows":(0..5000).collect::<Vec<_>>()},
            "pages":{"rows":[1]},"query_pages":{"rows":[2]},"previous_period":{},"analysis":{},
            "measurement":{"provider_completeness":"not_guaranteed"}});
        let result = dashboard_projection(&data);
        assert_eq!(result["queries"]["rows"].as_array().unwrap().len(), 10);
        assert_eq!(result["queries"]["presentation"]["truncated"], true);
        assert_eq!(result["pages"]["presentation"]["truncated"], false);
        assert_eq!(result["measurement"], data["measurement"]);
        assert!(result.get("query_pages").is_none());
        assert!(result.get("previous_period").is_none());
        assert!(result.get("analysis").is_none());
        assert_eq!(data["queries"]["rows"].as_array().unwrap().len(), 5000);
        assert!(dashboard_projection(&Value::Null).is_null());
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
    #[test]
    fn dataset_pages_preserve_metadata_and_require_exact_period() {
        let mut saved = json!({"sync":{"exact_range_available":true,"fetched_at":"2026-11-01"},
            "data":{"measurement":{"version":1},"queries":{"rows":[{"keys":["a"]},{"keys":["b"]}],
            "collection":{"truncated":true,"anonymized_queries":"excluded"}}}});
        let page = dataset_projection(&saved, "queries", 0, 1);
        assert_eq!(page["rows"].as_array().unwrap().len(), 1);
        assert_eq!(page["has_more"], true);
        assert_eq!(page["collection"]["truncated"], true);
        assert_eq!(page["measurement"]["version"], 1);
        saved["sync"]["exact_range_available"] = json!(false);
        let unavailable = dataset_projection(&saved, "queries", 0, 1);
        assert_eq!(unavailable["reason"], "exact_period_snapshot_unavailable");
        assert!(unavailable["rows"].as_array().unwrap().is_empty());
        saved["sync"]["exact_range_available"] = json!(true);
        assert_eq!(
            dataset_projection(&saved, "countries", 0, 1)["reason"],
            "dataset_unavailable"
        );
    }
    #[test]
    fn exact_freshness_and_daily_status_remain_separate() {
        let saved = json!({"sync":{"exact_range_available":true,"snapshot_id":7,"fetched_at":"2026-01-01T00:00:00Z","state":"stale"},"daily_sync":{"fetched_at":"2026-11-01T00:00:00Z","state":"error","last_error":"google_quota_exceeded"},"data":{"queries":{"rows":[]},"query_page_segments":{"unavailable":true,"reason":"segment_collection_unavailable"}}});
        let result = dataset_projection(&saved, "queries", 0, 25);
        assert_eq!(result["sync"]["snapshot_id"], 7);
        assert_eq!(result["sync"]["state"], "stale");
        assert_eq!(result["daily_sync"]["state"], "error");
        assert_eq!(
            dataset_projection(&saved, "query_page_segments", 0, 25)["reason"],
            "segment_collection_unavailable"
        );
    }
    #[test]
    fn database_bounded_pages_are_returned_without_reslicing() {
        // The database returns the already-selected page plus `page` metadata.
        // The projection must use those rows and counts directly.
        let saved = json!({"sync":{"exact_range_available":true,"snapshot_id":7,"state":"ready"},
            "data":{"measurement":{"version":1},"queries":{"rows":[{"keys":["b"]}],
            "collection":{"truncated":false,"anonymized_queries":"excluded"}}},
            "daily_sync":{"state":"ready","coverage":{"state":"complete"}},
            "page":{"retained_rows":5,"has_more":true,"invalid_rows_omitted":0}});
        let result = dataset_projection(&saved, "queries", 1, 1);
        assert_eq!(result["rows"].as_array().unwrap().len(), 1);
        assert_eq!(result["rows"][0]["keys"][0], "b");
        assert_eq!(result["retained_rows"], 5);
        assert_eq!(result["has_more"], true);
        assert_eq!(result["daily_sync"]["coverage"]["state"], "complete");
    }
    #[test]
    fn database_bounded_segment_page_keeps_omission_count() {
        let saved = json!({"sync":{"exact_range_available":true},
            "data":{"query_page_segments":{"rows":[
              {"keys":["q","https://example.com/","MOBILE","usa"],"clicks":1}],
              "collection":{"truncated":true}}},
            "page":{"retained_rows":3,"has_more":true,"invalid_rows_omitted":2}});
        let result = segment_projection(&saved, Some("MOBILE"), Some("usa"), 0, 1);
        assert_eq!(result["rows"].as_array().unwrap().len(), 1);
        assert_eq!(result["retained_rows"], 3);
        assert_eq!(result["has_more"], true);
        assert_eq!(result["invalid_rows_omitted"], 2);
    }
    #[test]
    fn database_bounded_landing_page_uses_retained_total() {
        let saved = json!({"sync":{"exact_range_available":true},
            "data":{"analysis":{"landing_outcomes":{"available":true,"rows":[{"landing_page":"/"}],
              "collection":{"truncated":false}}}},
            "page":{"retained_rows":4,"has_more":true,"invalid_rows_omitted":0}});
        let result = landing_projection(&saved, 2, 1);
        assert_eq!(result["rows"].as_array().unwrap().len(), 1);
        assert_eq!(result["retained_rows"], 4);
        assert_eq!(result["has_more"], true);
    }
    #[test]
    fn bounded_projection_matches_established_snapshot_projection() {
        // Representative authentic producer metadata: a page/query dataset with
        // a collection object, an analysis object whose candidate evidence
        // exceeds the public 25-row bound and which carries a large sibling
        // landing_outcomes, and a landing_outcomes object. The full snapshot is
        // the established in-process path; the bounded payload is the shape
        // read_search_dataset_page returns. The public projections must match.
        let evidence: Vec<Value> = (0..30).map(|i| json!({"keys": [i.to_string()]})).collect();
        let landing: Vec<Value> = (0..2)
            .map(|i| json!({"landing_page": format!("/{i}"), "metrics": {"sessions": i}}))
            .collect();
        let full = json!({
            "sync":{"exact_range_available":true,"snapshot_id":7,"state":"ready"},
            "daily_sync":{"state":"ready","coverage":{"state":"complete"}},
            "data":{
                "measurement":{"version":1},
                "queries":{"rows":[{"keys":["a"]},{"keys":["b"]}],
                    "collection":{"truncated":false,"anonymized_queries":"excluded"}},
                "analysis":{
                    "semantics_version":1,
                    "policy":{"min_impressions":100},
                    "coverage":{"scope":"retained_observations_only"},
                    "comparison":{"available":true,"reason":null},
                    "candidates":[{"kind":"low_ctr_review","page":"/","evidence":evidence.clone()}],
                    "landing_outcomes":{"available":true,"reason":null,"rows":landing.clone()}
                }
            }
        });
        let bounded_queries = json!({
            "sync":{"exact_range_available":true,"snapshot_id":7,"state":"ready"},
            "daily_sync":{"state":"ready","coverage":{"state":"complete"}},
            "data":{
                "measurement":{"version":1},
                "queries":{"rows":[{"keys":["a"]}],
                    "collection":{"truncated":false,"anonymized_queries":"excluded"},"reason":null}
            },
            "page":{"retained_rows":2,"has_more":true,"invalid_rows_omitted":0}
        });
        assert_eq!(
            dataset_projection(&full, "queries", 0, 1),
            dataset_projection(&bounded_queries, "queries", 0, 1)
        );
        let bounded_analysis = json!({
            "sync":{"exact_range_available":true,"snapshot_id":7,"state":"ready"},
            "daily_sync":{"state":"ready","coverage":{"state":"complete"}},
            "data":{
                "measurement":{"version":1},
                "analysis":{
                    "semantics_version":1,
                    "policy":{"min_impressions":100},
                    "coverage":{"scope":"retained_observations_only"},
                    "comparison":{"available":true,"reason":null},
                    "candidates":[{"kind":"low_ctr_review","page":"/","evidence":evidence[..25].to_vec(),
                        "evidence_presentation":{"retained_rows":30,"returned_rows":25,"truncated":true}}]
                }
            },
            "page":{"retained_rows":1,"has_more":false,"invalid_rows_omitted":0}
        });
        assert_eq!(
            dataset_projection(&full, "analysis", 0, 25),
            dataset_projection(&bounded_analysis, "analysis", 0, 25)
        );
        // The bounded analysis projection does not carry the sibling rows and
        // keeps the database-computed retained/returned evidence counts.
        let projected = dataset_projection(&bounded_analysis, "analysis", 0, 25);
        assert!(projected["rows"][0].get("landing_outcomes").is_none());
        assert_eq!(
            projected["rows"][0]["evidence_presentation"]["retained_rows"],
            30
        );
        let full_landing = json!({
            "sync":{"exact_range_available":true,"snapshot_id":7,"state":"ready"},
            "daily_sync":{"state":"ready"},
            "data":{
                "measurement":{"version":1},
                "analysis":{"landing_outcomes":{"available":true,"reason":null,
                    "collection":{"truncated":false},"attribution":"all_channels","rows":landing.clone()}},
                "pages":{"metadata":{"currencyCode":"USD"}}
            }
        });
        let bounded_landing = json!({
            "sync":{"exact_range_available":true,"snapshot_id":7,"state":"ready"},
            "daily_sync":{"state":"ready"},
            "data":{
                "measurement":{"version":1},
                "analysis":{"landing_outcomes":{"available":true,"reason":null,
                    "collection":{"truncated":false},"attribution":"all_channels","rows":[landing[0].clone()]}},
                "pages":{"metadata":{"currencyCode":"USD"}}
            },
            "page":{"retained_rows":2,"has_more":true,"invalid_rows_omitted":0}
        });
        assert_eq!(
            landing_projection(&full_landing, 0, 1),
            landing_projection(&bounded_landing, 0, 1)
        );
    }
    #[test]
    fn segments_filter_only_retained_matching_dimensions() {
        let saved = json!({"sync":{"exact_range_available":true},"data":{"query_page_segments":{
            "collection":{"truncated":true,"anonymized_queries":"excluded"},"rows":[
              {"keys":["q","https://example.com/","MOBILE","usa"],"clicks":1},
              {"keys":["q","https://example.com/","DESKTOP","usa"],"clicks":2},
              {"keys":["q","https://example.com/","MOBILE","can"],"clicks":3},
              {"keys":["malformed"]},
              {"foo":1},
              {"keys":null},
              7,
              {"keys":["a","b","c",5]}]}}});
        let page = segment_projection(&saved, Some("MOBILE"), Some("usa"), 0, 10);
        assert_eq!(page["retained_rows"], 1);
        assert_eq!(page["rows"][0]["clicks"], 1);
        assert_eq!(page["collection"]["truncated"], true);
        assert_eq!(page["invalid_rows_omitted"], 5);
        assert_eq!(page["filter_scope"], "retained_bounded_rows_only");
        assert_eq!(
            segment_projection(&saved, Some("TABLET"), None, 0, 10)["retained_rows"],
            0
        );
        assert_eq!(
            segment_projection(
                &json!({"sync":{"exact_range_available":false}}),
                None,
                None,
                0,
                10
            )["available"],
            false
        );
    }
    #[test]
    fn landing_projection_requires_exact_valid_observation() {
        let mut saved = json!({"sync":{"exact_range_available":true},"data":{"analysis":{"landing_outcomes":{"available":true,"rows":[{"landing_page":"/","metrics":{"sessions":0}}],"collection":{"truncated":false}}}}});
        let result = landing_projection(&saved, 0, 25);
        assert_eq!(result["rows"][0]["metrics"]["sessions"], 0);
        assert_eq!(result["collection"]["truncated"], false);
        saved["sync"]["exact_range_available"] = json!(false);
        assert_eq!(
            landing_projection(&saved, 0, 25)["reason"],
            "exact_period_snapshot_unavailable"
        );
        saved["sync"]["exact_range_available"] = json!(true);
        saved["data"]["analysis"]["landing_outcomes"]["available"] = json!(false);
        saved["data"]["analysis"]["landing_outcomes"]["reason"] = json!("thresholded_or_sampled");
        assert_eq!(
            landing_projection(&saved, 0, 25)["reason"],
            "thresholded_or_sampled"
        );
        assert!(
            landing_projection(&saved, 0, 25)["rows"]
                .as_array()
                .unwrap()
                .is_empty()
        );
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
                if uri.path() == "/rest/v1/rpc/read_search_dataset_page" {
                    assert_eq!(headers["authorization"], "Bearer owner-token");
                    assert_eq!(input["p_dataset"], "queries");
                    return Json(json!({"data":{"queries":{"rows":[]}},"sync":{"exact_range_available":true,"snapshot_id":5,"fetched_at":"2026-10-01T00:00:00Z","state":"stale"},"daily_sync":{"state":"ready"},"page":{"retained_rows":0,"has_more":false,"invalid_rows_omitted":0}}));
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
                if uri.path() == "/rest/v1/rpc/search_crawl_evidence" {
                    assert_eq!(headers["authorization"], "Bearer owner-token");
                    return Json(json!({"available":true,"coverage":"unknown","findings":[],"evaluations":[]}));
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
        let dataset = json!({"site_url":"sc-domain:example.com","start_date":"2026-10-01","end_date":"2026-10-27","dataset":"queries","offset":0,"limit":25});
        assert_eq!(
            call(app.clone(), "dataset", dataset.clone()).await.status(),
            StatusCode::OK
        );
        let mut invalid_dataset = dataset;
        invalid_dataset["limit"] = json!(101);
        assert_eq!(
            call(app.clone(), "dataset", invalid_dataset).await.status(),
            StatusCode::BAD_REQUEST
        );
        let crawl = json!({"site_url":"sc-domain:example.com","url":"https://example.com/jobs/1","delivery_id":"00000000-0000-0000-0000-000000000004"});
        assert_eq!(
            call(app.clone(), "crawl-evidence", crawl.clone())
                .await
                .status(),
            StatusCode::OK
        );
        let mut bad_crawl = crawl;
        bad_crawl["url"] = json!("https://other.example/jobs/1");
        assert_eq!(
            call(app.clone(), "crawl-evidence", bad_crawl)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
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
