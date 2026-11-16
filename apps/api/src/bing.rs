//! Saved Bing observations. Only the background collector contacts Bing.
use crate::websites::{WebsiteError, WebsiteStore, saved_response};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::HeaderMap,
    response::Response,
    routing::post,
};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryRange {
    start_date: chrono::NaiveDate,
    end_date: chrono::NaiveDate,
}

pub(crate) fn router(store: WebsiteStore) -> Router {
    Router::new()
        .route("/websites/{id}/bing/dashboard", post(dashboard))
        .with_state(store)
}
async fn dashboard(
    State(store): State<WebsiteStore>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<HistoryRange>,
) -> Result<Response, WebsiteError> {
    store.find(id, &headers).await?;
    let saved = store
        .rpc(
            &headers,
            "read_bing_history",
            json!({"p_website_id":id,"p_start_date":input.start_date,"p_end_date":input.end_date}),
        )
        .await?;
    Ok(saved_response(saved["data"].clone(), &saved["sync"]))
}
