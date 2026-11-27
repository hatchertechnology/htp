//! Owner-only read of S14 wire-2 evidence families (WP8c-3).
//!
//! `GET /websites/{id}/seosmith/audits/{delivery_id}/evidence-families` forwards the
//! caller's JWT to the held `seosmith_audit_evidence_families` RPC (migration 15) and
//! relays its small JSON object. The RPC does the ownership check; this route never
//! uses a privileged credential. A v1 audit answers 200 with `reason: "not_collected"`.
//! A nonowner, an unknown delivery and a delivery of another website are all 404, so
//! the route does not reveal which audits exist. With the rollout flag off it answers
//! 503 before touching the database, like the other held routes.
use crate::websites::{WebsiteError, WebsiteStore};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};
use uuid::Uuid;

const RPC: &str = "seosmith_audit_evidence_families";

#[derive(Clone)]
struct FamiliesState {
    store: WebsiteStore,
    enabled: bool,
}

pub(crate) fn router(store: WebsiteStore, enabled: bool) -> Router {
    Router::new()
        .route(
            "/websites/{id}/seosmith/audits/{delivery}/evidence-families",
            get(read),
        )
        .with_state(FamiliesState { store, enabled })
}

async fn read(
    State(state): State<FamiliesState>,
    headers: HeaderMap,
    Path((website, delivery)): Path<(String, String)>,
) -> Response {
    if !state.enabled {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "This feature is not available yet."})),
        )
            .into_response();
    }
    // Ids are validated after the flag check, so a held route answers 503 for any id.
    let (Ok(website), Ok(delivery)) = (Uuid::parse_str(&website), Uuid::parse_str(&delivery))
    else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let result = state
        .store
        .rpc(
            &headers,
            RPC,
            json!({"p_website_id": website, "p_delivery_id": delivery}),
        )
        .await;
    match result {
        Ok(Value::Object(object)) => (
            [(header::CACHE_CONTROL, "no-store")],
            Json(Value::Object(object)),
        )
            .into_response(),
        // SQL null: unknown delivery, or one that belongs to another website.
        // `forbidden` (42501): the caller does not own the website.
        Ok(Value::Null) | Err(WebsiteError::Forbidden) => WebsiteError::NotFound.into_response(),
        Ok(_) => WebsiteError::Unavailable.into_response(),
        Err(error) => error.into_response(),
    }
}
