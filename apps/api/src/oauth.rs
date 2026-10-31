//! OAuth discovery for the protected MCP resource. Supabase owns code/PKCE/token handling.
use axum::{Json, Router, routing::get};
use serde_json::json;

pub(crate) fn resource_url() -> String {
    std::env::var("MCP_RESOURCE_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:3000/mcp/secured".to_owned())
}

pub(crate) fn metadata_url() -> String {
    let resource = reqwest::Url::parse(&resource_url()).expect("valid MCP_RESOURCE_URL");
    format!(
        "{}/.well-known/oauth-protected-resource{}",
        resource.origin().ascii_serialization(),
        resource.path()
    )
}

pub(crate) fn router(project_url: &str) -> Router {
    let metadata = json!({
        "resource": resource_url(),
        "resource_name": "Hatch website data",
        "authorization_servers": [format!("{}/auth/v1", project_url.trim_end_matches('/'))],
        "scopes_supported": ["openid", "email", "profile", "offline_access"],
        "bearer_methods_supported": ["header"],
        "resource_documentation": "https://htp.hatchtech.dev/mcp"
    });
    Router::new()
        .route(
            "/.well-known/oauth-protected-resource",
            get({
                let metadata = metadata.clone();
                move || async move { Json(metadata) }
            }),
        )
        .route(
            "/.well-known/oauth-protected-resource/mcp/secured",
            get(move || async move { Json(metadata) }),
        )
}
