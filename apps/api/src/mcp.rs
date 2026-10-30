use rmcp::{
    ServerHandler,
    model::{CallToolResult, Implementation, ServerCapabilities, ServerConfig},
    tool, tool_handler, tool_router,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};

#[derive(Clone)]
pub(crate) struct HelloWorldMcp;

#[tool_router]
impl HelloWorldMcp {
    #[tool(
        description = "Return the hello world message from the HTP API",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true
        )
    )]
    fn hello_world() -> CallToolResult {
        CallToolResult::structured(serde_json::json!(super::message()))
    }
}

// The SDK generates async trait methods even for synchronous tools.
#[allow(clippy::unused_async_trait_impl)]
#[tool_handler]
impl ServerHandler for HelloWorldMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("htp-api", env!("CARGO_PKG_VERSION")))
            .with_instructions("Use hello_world to retrieve the API's greeting.")
    }
}

pub(crate) fn service() -> StreamableHttpService<HelloWorldMcp, LocalSessionManager> {
    StreamableHttpService::new(
        || Ok(HelloWorldMcp),
        LocalSessionManager::default().into(),
        config(),
    )
}

#[derive(Clone)]
pub(crate) struct SecuredHelloWorldMcp;

#[tool_router]
impl SecuredHelloWorldMcp {
    #[tool(
        description = "Return the secured hello world message for a signed-in Supabase user",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true
        )
    )]
    fn hello_world_secured() -> CallToolResult {
        CallToolResult::structured(serde_json::json!(super::secured_message()))
    }
}

// The SDK generates async trait methods even for synchronous tools.
#[allow(clippy::unused_async_trait_impl)]
#[tool_handler]
impl ServerHandler for SecuredHelloWorldMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                "htp-api-secured",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions("Use hello_world_secured to retrieve the secured greeting.")
    }
}

pub(crate) fn secured_service() -> StreamableHttpService<SecuredHelloWorldMcp, LocalSessionManager>
{
    StreamableHttpService::new(
        || Ok(SecuredHelloWorldMcp),
        LocalSessionManager::default().into(),
        config(),
    )
}

fn config() -> StreamableHttpServerConfig {
    StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .with_allowed_hosts(env_list("MCP_ALLOWED_HOSTS", "localhost,127.0.0.1,::1"))
        .with_allowed_origins(env_list(
            "MCP_ALLOWED_ORIGINS",
            "http://localhost:3000,http://127.0.0.1:3000",
        ))
        .enforce_origin_validation()
}

fn env_list(name: &str, default: &str) -> Vec<String> {
    std::env::var(name)
        .unwrap_or_else(|_| default.to_owned())
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}
