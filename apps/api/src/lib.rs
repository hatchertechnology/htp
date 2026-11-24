//! HTTP and MCP routes for the HTP API.

pub mod analytics;
mod audit_export;
pub mod auth;
mod bing;
mod form_inbox;
mod form_ingress;
mod form_verification;
mod insights;
mod mcp;
mod oauth;
mod repositories;
mod s14_worker;
pub mod search;
mod seosmith;
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
    app_with_capabilities(auth, websites, analytics, RolloutCapabilities::from_env())
}

/// Explicit availability controls; they never replace authentication or database ACLs.
#[derive(Clone, Copy, Default)]
pub struct RolloutCapabilities {
    pub search_evidence: bool,
    pub lifecycle: bool,
    pub remediation: bool,
}
impl RolloutCapabilities {
    fn from_env() -> Self {
        Self {
            search_evidence: std::env::var("HTP_ROLLOUT_SEARCH_EVIDENCE").as_deref() == Ok("true"),
            lifecycle: std::env::var("HTP_ROLLOUT_LIFECYCLE").as_deref() == Ok("true"),
            remediation: std::env::var("HTP_ROLLOUT_REMEDIATION").as_deref() == Ok("true"),
        }
    }
}

pub fn app_with_capabilities(
    auth: auth::SupabaseAuth,
    websites: websites::WebsiteStore,
    analytics: analytics::AnalyticsClient,
    capabilities: RolloutCapabilities,
) -> Router {
    let oauth_routes = oauth::router(auth.project_url());
    let seosmith_ingest = seosmith::ingest_router(websites.clone());
    let mcp_limit = std::sync::Arc::new(tokio::sync::Semaphore::new(4));
    let mcp_routes = Router::new()
        .nest_service("/mcp/secured", mcp::secured_service(websites.clone()))
        .layer(middleware::from_fn_with_state(
            mcp_limit,
            limit_mcp_responses,
        ));
    let protected = Router::new()
        .route("/secured", get(async || Json(secured_message())))
        .merge(mcp_routes)
        .merge(analytics::router(websites.clone(), analytics))
        .merge(search::router(
            websites.clone(),
            search::SearchClient::default(),
        ))
        .merge(insights::router(websites.clone()))
        .merge(bing::router(websites.clone()))
        .merge(seosmith::read_router(websites.clone()))
        .merge(repositories::router(websites.clone()))
        .merge(form_verification::router(
            form_verification::FormVerificationState {
                verifier: websites.forms_verifier(),
                enabled: form_verification::enabled_from_env(),
            },
        ))
        .merge(form_inbox::router(form_inbox::FormInboxState {
            reader: websites.forms_reader(),
            enabled: form_inbox::enabled_from_env(),
            pilot: form_inbox::pilot_from_env(),
        }))
        .merge(websites::router(websites))
        .layer(middleware::from_fn_with_state(capabilities, rollout_gate))
        .layer(middleware::from_fn_with_state(auth, auth::require_user));

    Router::new()
        .route("/", get(async || Json(message())))
        .nest_service("/mcp", mcp::service())
        .merge(oauth_routes)
        .merge(seosmith_ingest)
        .merge(s14_worker::router())
        .merge(form_ingress::router())
        .merge(protected)
}

async fn rollout_gate(
    axum::extract::State(capabilities): axum::extract::State<RolloutCapabilities>,
    request: axum::extract::Request,
    next: middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let path: Vec<_> = request.uri().path().split('/').collect();
    let held = match path.as_slice() {
        ["", "websites", _, "search", "dataset" | "crawl-evidence"] => {
            !capabilities.search_evidence
        }
        [
            "",
            "websites",
            _,
            "seo",
            "audits",
            "lifecycle" | "url-lifecycle",
        ] => !capabilities.lifecycle,
        ["", "websites", _, "seo", "audits", _, "work"]
        | ["", "websites", _, "seo", "work", _, "attempts"] => !capabilities.remediation,
        _ => false,
    };
    if held {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error":"This feature is not available yet."})),
        )
            .into_response();
    }
    next.run(request).await
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

// An expensive tool reserves its request-local slot; the body owns that slot
// until the client consumes or drops it, including rmcp serialization time.
#[derive(Clone)]
pub(crate) struct McpAdmission {
    limit: std::sync::Arc<tokio::sync::Semaphore>,
    held: std::sync::Arc<std::sync::Mutex<Option<tokio::sync::OwnedSemaphorePermit>>>,
}
impl McpAdmission {
    pub(crate) fn acquire(&self) -> bool {
        let Ok(permit) = self.limit.clone().try_acquire_owned() else {
            return false;
        };
        let Ok(mut held) = self.held.lock() else {
            return false;
        };
        if held.is_some() {
            return false;
        }
        *held = Some(permit);
        true
    }
}
async fn limit_mcp_responses(
    axum::extract::State(limit): axum::extract::State<std::sync::Arc<tokio::sync::Semaphore>>,
    mut request: axum::extract::Request,
    next: middleware::Next,
) -> axum::response::Response {
    use futures_util::StreamExt as _;
    let held = std::sync::Arc::new(std::sync::Mutex::new(None));
    request.extensions_mut().insert(McpAdmission {
        limit,
        held: held.clone(),
    });
    let response = next.run(request).await;
    let (parts, body) = response.into_parts();
    let stream = body.into_data_stream().map(move |result| {
        let _keep = &held;
        result
    });
    axum::response::Response::from_parts(parts, axum::body::Body::from_stream(stream))
}
