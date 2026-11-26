//! HTTP and MCP routes for the HTP API.

pub mod analytics;
mod audit_export;
pub mod auth;
mod bing;
mod dashboard_cors;
mod form_confirmation;
mod form_inbox;
mod form_ingress;
mod form_notifications;
mod form_responses;
mod form_save;
mod form_verification;
mod independent_audit;
mod insights;
mod mcp;
mod oauth;
mod playground;
mod provider_management;
mod provider_oauth;
mod providers;
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
    pub comparisons: bool,
    pub comparisons_read_only: bool,
}
impl RolloutCapabilities {
    fn from_env() -> Self {
        Self {
            search_evidence: std::env::var("HTP_ROLLOUT_SEARCH_EVIDENCE").as_deref() == Ok("true"),
            lifecycle: std::env::var("HTP_ROLLOUT_LIFECYCLE").as_deref() == Ok("true"),
            comparisons: std::env::var("HTP_ROLLOUT_COMPARISONS").as_deref() == Ok("true"),
            comparisons_read_only: std::env::var("HTP_ROLLOUT_COMPARISONS_READ_ONLY").as_deref()
                == Ok("true"),
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
    let provider_oauth = provider_oauth::OAuth::from_env();
    let seosmith_ingest = seosmith::ingest_router(websites.clone());
    let s14_policy_ingest = s14_worker::router(websites.clone());
    let mcp_limit = std::sync::Arc::new(tokio::sync::Semaphore::new(4));
    let mcp_routes = Router::new()
        .nest_service(
            "/mcp/secured",
            mcp::secured_service_with(websites.clone(), capabilities),
        )
        .layer(middleware::from_fn_with_state(
            mcp_limit,
            limit_mcp_responses,
        ));
    let protected = Router::new()
        .route("/secured", get(async || Json(secured_message())))
        .route(
            "/playground/secured",
            axum::routing::post(playground::secured),
        )
        .merge(mcp_routes)
        .merge(providers::router())
        .merge(provider_oauth.protected())
        .merge(analytics::router(websites.clone(), analytics))
        .merge(search::router(
            websites.clone(),
            search::SearchClient::default(),
        ))
        .merge(independent_audit::router(websites.clone()))
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
        .merge(form_save::router(form_save::state_from_env(
            websites.forms_saver(),
        )))
        .merge(form_responses::router(form_responses::state_from_env(
            websites.forms_response_writer(),
        )))
        .merge(form_notifications::router(
            form_notifications::state_from_env(
                websites.forms_notification_client(),
                websites.forms_reader(),
            ),
        ))
        .merge(websites::router(websites))
        .layer(middleware::from_fn_with_state(capabilities, rollout_gate))
        .layer(middleware::from_fn_with_state(auth, auth::require_user));

    let root = Router::new()
        .route("/", get(async || Json(message())))
        .route(
            "/playground/public",
            axum::routing::post(playground::public),
        )
        .nest_service("/mcp", mcp::service())
        .merge(oauth_routes)
        .merge(provider_oauth.public())
        .merge(seosmith_ingest)
        .merge(s14_policy_ingest)
        .merge(form_ingress::router())
        .merge(form_confirmation::router())
        .merge(protected);

    // Opt-in exact-origin CORS for the static dashboard's website routes only.
    // Mounted outside the auth layer so preflights are answered without credentials.
    // An invalid configured origin stops startup rather than widening access.
    let dashboard_origin = std::env::var(dashboard_cors::ORIGIN_ENV).ok();
    match dashboard_cors::DashboardCors::from_setting(dashboard_origin.as_deref()) {
        Ok(Some(cors)) => root.layer(middleware::from_fn_with_state(cors, dashboard_cors::layer)),
        Ok(None) => root,
        Err(error) => panic!("{}: {error}", dashboard_cors::ORIGIN_ENV),
    }
}

async fn rollout_gate(
    axum::extract::State(capabilities): axum::extract::State<RolloutCapabilities>,
    request: axum::extract::Request,
    next: middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let path: Vec<_> = request.uri().path().split('/').collect();
    let held = match path.as_slice() {
        [
            "",
            "websites",
            _,
            "independent-audits" | "independent-comparisons",
        ]
        | [
            "",
            "websites",
            _,
            "independent-audits" | "independent-comparisons",
            _,
        ]
        | ["", "websites", _, "independent-evidence"]
        | ["", "websites", _, "independent-evidence", "fingerprint"] => {
            if request.method() == axum::http::Method::GET {
                !(capabilities.comparisons || capabilities.comparisons_read_only)
            } else {
                !capabilities.comparisons || capabilities.comparisons_read_only
            }
        }
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

#[cfg(test)]
mod gated_evidence_tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        routing::any,
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn evidence_routes_require_their_authoritative_capability() {
        let id = "00000000-0000-0000-0000-000000000001";
        for (resource, methods, capability) in [
            ("search/dataset".to_owned(), vec!["POST"], 0),
            ("search/crawl-evidence".to_owned(), vec!["POST"], 0),
            ("seo/audits/lifecycle".to_owned(), vec!["GET"], 1),
            ("seo/audits/url-lifecycle".to_owned(), vec!["GET"], 1),
            (format!("seo/audits/{id}/work"), vec!["GET", "POST"], 2),
            (format!("seo/work/{id}/attempts"), vec!["POST"], 2),
        ] {
            let path = format!("/websites/{id}/{resource}");
            for method in methods {
                for enabled in [None, Some(0), Some(1), Some(2)] {
                    let caps = RolloutCapabilities {
                        search_evidence: enabled == Some(0),
                        lifecycle: enabled == Some(1),
                        remediation: enabled == Some(2),
                        ..Default::default()
                    };
                    let app = Router::new()
                        .route(&path, any(|| async { "synthetic" }))
                        .layer(middleware::from_fn_with_state(caps, rollout_gate));
                    let response = app
                        .oneshot(
                            Request::builder()
                                .uri(&path)
                                .method(method)
                                .body(Body::empty())
                                .unwrap(),
                        )
                        .await
                        .unwrap();
                    assert_eq!(
                        response.status(),
                        if enabled == Some(capability) {
                            StatusCode::OK
                        } else {
                            StatusCode::SERVICE_UNAVAILABLE
                        },
                        "{method} {path}"
                    );
                }
            }
        }
    }
}
