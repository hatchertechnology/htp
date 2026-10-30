//! Database-backed site health, conversion, and Business Profile reports.
use crate::websites::{WebsiteError, WebsiteStore};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::HeaderMap,
    routing::{post, put},
};
use chrono::NaiveDate;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

pub(crate) fn router(store: WebsiteStore) -> Router {
    Router::new()
        .route("/websites/{id}/insights/report", post(report))
        .route("/websites/{id}/insights/history", post(history))
        .route("/websites/{id}/business/location", put(location))
        .with_state(store)
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Pagespeed,
    Crux,
    Conversions,
    BusinessLocations,
    BusinessProfile,
    BusinessPerformance,
}
impl Kind {
    fn name(&self) -> &'static str {
        match self {
            Self::Pagespeed => "pagespeed",
            Self::Crux => "crux",
            Self::Conversions => "conversions",
            Self::BusinessLocations => "business_locations",
            Self::BusinessProfile => "business_profile",
            Self::BusinessPerformance => "business_performance",
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReportInput {
    kind: Kind,
    property_id: String,
    start_date: NaiveDate,
    end_date: NaiveDate,
    before_id: Option<i64>,
}
impl ReportInput {
    fn validate(&self) -> Result<(), WebsiteError> {
        let days = (self.end_date - self.start_date).num_days();
        if !(0..366).contains(&days)
            || self.property_id.len() > 2048
            || self.before_id.is_some_and(|id| id <= 0)
        {
            return Err(WebsiteError::Invalid(
                "Choose a valid source and date range of at most 366 days.",
            ));
        }
        Ok(())
    }
}
async fn report(
    State(store): State<WebsiteStore>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<ReportInput>,
) -> Result<Json<Value>, WebsiteError> {
    input.validate()?;
    store.find(id, &headers).await?;
    let saved = store
        .saved_report(
            &headers,
            id,
            input.kind.name(),
            &input.property_id,
            &input.start_date.to_string(),
            &input.end_date.to_string(),
        )
        .await?;
    Ok(Json(saved))
}
async fn history(
    State(store): State<WebsiteStore>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<ReportInput>,
) -> Result<Json<Value>, WebsiteError> {
    input.validate()?;
    store.find(id, &headers).await?;
    Ok(Json(store.rpc(&headers, "google_insight_history", json!({"p_website_id":id,"p_kind":input.kind.name(),"p_property_id":input.property_id,"p_start_date":input.start_date,"p_end_date":input.end_date,"p_before_id":input.before_id})).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LocationInput {
    location_id: String,
    linked: bool,
}
async fn location(
    State(store): State<WebsiteStore>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<LocationInput>,
) -> Result<Json<Value>, WebsiteError> {
    let number = input.location_id.strip_prefix("locations/").unwrap_or("");
    if number.is_empty() || number.len() > 100 || !number.bytes().all(|b| b.is_ascii_digit()) {
        return Err(WebsiteError::Invalid(
            "Choose a valid Business Profile location.",
        ));
    }
    store.find(id, &headers).await?;
    Ok(Json(store.rpc(&headers, "set_business_location", json!({"p_website_id":id,"p_location_id":input.location_id,"p_linked":input.linked})).await?))
}
