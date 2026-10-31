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
struct Empty {}

pub(crate) fn router(store: WebsiteStore) -> Router {
    Router::new()
        .route("/websites/{id}/bing/dashboard", post(dashboard))
        .with_state(store)
}
async fn dashboard(
    State(store): State<WebsiteStore>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(_): Json<Empty>,
) -> Result<Response, WebsiteError> {
    store.find(id, &headers).await?;
    let saved = store
        .rpc(&headers, "request_bing_report", json!({"p_website_id":id}))
        .await?;
    Ok(saved_response(saved["data"].clone(), &saved["sync"]))
}
