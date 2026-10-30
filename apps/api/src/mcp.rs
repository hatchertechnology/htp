use rmcp::schemars;
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
pub(crate) struct SecuredHelloWorldMcp {
    store: crate::websites::WebsiteStore,
}

#[derive(serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct RepositoryToolInput {
    fqdn: String,
    repository_url: Option<String>,
    branch: Option<String>,
    #[serde(default = "tool_enabled")]
    enabled: bool,
}
fn tool_enabled() -> bool {
    true
}
#[derive(serde::Deserialize, rmcp::schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct RepositoryHistoryInput {
    fqdn: String,
    start_date: Option<String>,
    end_date: Option<String>,
    before_id: Option<i64>,
}

fn repository_tool_result(
    result: Result<serde_json::Value, crate::websites::WebsiteError>,
) -> CallToolResult {
    match result {
        Ok(value) => CallToolResult::structured(value),
        Err(_) => CallToolResult::error(vec![rmcp::model::ContentBlock::text(
            "Repository request failed. Check website ownership, the GitHub URL, and the date range.",
        )]),
    }
}

#[tool_router]
impl SecuredHelloWorldMcp {
    #[tool(
        description = "Attach, change, or pause a public GitHub repository for an FQDN owned by the signed-in user. Saves configuration; collection runs in the background. Null repository_url pauses collection and retains history.",
        annotations(destructive_hint = false, idempotent_hint = true)
    )]
    async fn set_website_repository(
        &self,
        rmcp::handler::server::wrapper::Parameters(input): rmcp::handler::server::wrapper::Parameters<RepositoryToolInput>,
        rmcp::handler::server::tool::Extension(parts): rmcp::handler::server::tool::Extension<
            axum::http::request::Parts,
        >,
    ) -> CallToolResult {
        let Ok(fqdn) = htp_shared::normalize_fqdn(&input.fqdn) else {
            return CallToolResult::error(vec![rmcp::model::ContentBlock::text(
                "Enter a valid FQDN.",
            )]);
        };
        repository_tool_result(
            crate::repositories::save(
                &self.store,
                &parts.headers,
                None,
                Some(&fqdn),
                crate::repositories::RepositoryInput {
                    repository_url: input.repository_url,
                    branch: input.branch,
                    enabled: input.enabled,
                },
            )
            .await,
        )
    }
    #[tool(
        description = "Read database-saved GitHub commit history and collection status for an FQDN owned by the signed-in user. Dates use YYYY-MM-DD in UTC. Commit dates do not establish deployment dates.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true
        )
    )]
    async fn website_repository_history(
        &self,
        rmcp::handler::server::wrapper::Parameters(input): rmcp::handler::server::wrapper::Parameters<RepositoryHistoryInput>,
        rmcp::handler::server::tool::Extension(parts): rmcp::handler::server::tool::Extension<
            axum::http::request::Parts,
        >,
    ) -> CallToolResult {
        let Ok(fqdn) = htp_shared::normalize_fqdn(&input.fqdn) else {
            return CallToolResult::error(vec![rmcp::model::ContentBlock::text(
                "Enter a valid FQDN.",
            )]);
        };
        let start = input
            .start_date
            .as_deref()
            .map(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d"))
            .transpose();
        let end = input
            .end_date
            .as_deref()
            .map(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d"))
            .transpose();
        let (Ok(start), Ok(end)) = (start, end) else {
            return CallToolResult::error(vec![rmcp::model::ContentBlock::text(
                "Use YYYY-MM-DD dates.",
            )]);
        };
        repository_tool_result(
            crate::repositories::read(
                &self.store,
                &parts.headers,
                None,
                Some(&fqdn),
                start,
                end,
                input.before_id,
            )
            .await,
        )
    }
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
            .with_instructions("Use the repository tools to manage public GitHub bindings and read saved commit history for your FQDNs.")
    }
}

pub(crate) fn secured_service(
    store: crate::websites::WebsiteStore,
) -> StreamableHttpService<SecuredHelloWorldMcp, LocalSessionManager> {
    StreamableHttpService::new(
        move || {
            Ok(SecuredHelloWorldMcp {
                store: store.clone(),
            })
        },
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
