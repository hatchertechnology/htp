//! HTTP and MCP routes for the HTP API.

pub mod analytics;
pub mod auth;
mod insights;
mod mcp;
pub mod search;
pub mod websites;

use axum::{Json, Router, middleware, routing::get};
use htp_shared::MessageResponse;

/// Build the REST and MCP application.
pub fn app() -> Router {
    let project_url =
        std::env::var("SUPABASE_URL").unwrap_or_else(|_| auth::SUPABASE_URL.to_owned());
    app_with_auth(auth::SupabaseAuth::new(&project_url))
}

/// Build the application with a shared verifier for the selected Supabase project.
pub fn app_with_auth(auth: auth::SupabaseAuth) -> Router {
    let url = std::env::var("SUPABASE_URL").unwrap_or_else(|_| auth::SUPABASE_URL.to_owned());
    let key = std::env::var("SUPABASE_PUBLISHABLE_KEY")
        .unwrap_or_else(|_| "sb_publishable_Loul540Y3Oj_qIojV0kr0w_Jq5vhn5H".to_owned());
    app_with_services(auth, websites::WebsiteStore::new(&url, &key))
}

/// Build the application with configurable authentication and website storage.
pub fn app_with_services(auth: auth::SupabaseAuth, websites: websites::WebsiteStore) -> Router {
    app_with_analytics(auth, websites, analytics::AnalyticsClient::default())
}

/// Build the application with a trusted Google Analytics client.
pub fn app_with_analytics(
    auth: auth::SupabaseAuth,
    websites: websites::WebsiteStore,
    analytics: analytics::AnalyticsClient,
) -> Router {
    let protected = Router::new()
        .route("/secured", get(async || Json(secured_message())))
        .nest_service("/mcp/secured", mcp::secured_service())
        .merge(analytics::router(websites.clone(), analytics))
        .merge(search::router(
            websites.clone(),
            search::SearchClient::default(),
        ))
        .merge(insights::router(websites.clone()))
        .merge(websites::router(websites))
        .layer(middleware::from_fn_with_state(auth, auth::require_user));

    Router::new()
        .route("/", get(async || Json(message())))
        .nest_service("/mcp", mcp::service())
        .merge(protected)
}

fn secured_message() -> MessageResponse {
    MessageResponse {
        message: "hello world secured".to_owned(),
    }
}

fn message() -> MessageResponse {
    MessageResponse {
        message: "hello world".to_owned(),
    }
}
