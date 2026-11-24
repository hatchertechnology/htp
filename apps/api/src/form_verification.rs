//! Owner-scoped Forms host verification for authenticated API/MCP callers.
//!
//! Both steps run as the caller. The caller's own Supabase bearer is forwarded
//! with the publishable key to the existing scoped `begin_form_host_verification`
//! RPC and the existing `form-verify` Edge Function. No privileged key is used,
//! and every grant, approval and ownership check stays in the database and the
//! function. The feature is default-off and fails closed.
//!
//! The DNS challenge token is returned only to the authorized caller so it can
//! be published as TXT. It is never logged, and error values never contain it.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use rmcp::model::CallToolResult;
use rmcp::{schemars, tool, tool_router};
use serde_json::{Value, json};
use std::time::Duration;
use uuid::Uuid;

/// Environment flag. Only the exact value `true` enables the tools.
pub(crate) const ENABLE_VAR: &str = "HTP_FORMS_VERIFICATION_MCP";

pub(crate) fn enabled_from_env() -> bool {
    std::env::var(ENABLE_VAR).as_deref() == Ok("true")
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct BeginInput {
    #[schemars(with = "String")]
    pub website_id: Uuid,
    /// Exact lowercase DNS hostname, such as www.example.com. No scheme, path,
    /// port, wildcard or trailing dot.
    pub hostname: String,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ConfirmInput {
    #[schemars(with = "String")]
    pub host_id: Uuid,
    /// The 64-character hex token from the begin result. Used once published
    /// as the TXT value `htp-verification=<token>`.
    pub token: String,
}

/// Stable, non-sensitive failure. `message` is fixed text, never upstream detail.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct FormError {
    pub code: &'static str,
    pub message: &'static str,
}

const NOT_ENABLED: FormError = FormError {
    code: "forms_verification_disabled",
    message: "Forms domain verification is not enabled on this server.",
};
const NOT_FOUND: FormError = FormError {
    code: "website_not_found",
    message: "Website not found or inaccessible.",
};
const UNAUTHORIZED: FormError = FormError {
    code: "unauthorized",
    message: "Sign in again.",
};
const INVALID: FormError = FormError {
    code: "invalid_request",
    message: "Invalid website ID, hostname, or token.",
};
const RATE_LIMITED: FormError = FormError {
    code: "rate_limited",
    message: "Too many verification requests. Wait before requesting another challenge.",
};
const HOST_LIMIT: FormError = FormError {
    code: "host_limit",
    message: "This website or account has reached its verification hostname limit.",
};
const UNAVAILABLE: FormError = FormError {
    code: "verification_unavailable",
    message: "Verification is temporarily unavailable. Retry later.",
};
const BEGIN_UNKNOWN: FormError = FormError {
    code: "verification_unknown_outcome",
    message: "The challenge outcome is unknown. Do not publish or assume a new value. Reconcile the site's Forms verification state before any further action.",
};
const CONFIRM_UNKNOWN: FormError = FormError {
    code: "verification_unknown_outcome",
    message: "The confirmation outcome is unknown. Do not assume success or failure. Reconcile the site's Forms verification state before any further action.",
};
const DNS_NOT_FOUND: FormError = FormError {
    code: "dns_record_not_verified",
    message: "The TXT record was not found or does not match. Publish the exact value, wait for DNS to propagate, and retry while the challenge is under 24 hours old.",
};
const CHALLENGE_CHANGED: FormError = FormError {
    code: "challenge_expired_or_changed",
    message: "The challenge expired or was replaced. Begin a new challenge and publish its new value.",
};
const HOST_NOT_FOUND: FormError = FormError {
    code: "host_not_found",
    message: "Host not found for this website or not owned by you.",
};

/// Single-label-safe exact hostname check. It mirrors the database rule: at
/// least two lowercase labels, no leading or trailing hyphen, and a non-numeric
/// final label. Uppercase is rejected, not normalized, so the caller states the
/// exact name.
pub(crate) fn valid_hostname(value: &str) -> bool {
    if !(3..=253).contains(&value.len()) || value.ends_with('.') {
        return false;
    }
    let labels: Vec<&str> = value.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    let label_ok = |label: &str| {
        let bytes = label.as_bytes();
        (1..=63).contains(&bytes.len())
            && bytes
                .iter()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
            && bytes[0] != b'-'
            && bytes[bytes.len() - 1] != b'-'
    };
    if !labels.iter().all(|l| label_ok(l)) {
        return false;
    }
    !labels
        .last()
        .is_some_and(|l| l.bytes().all(|b| b.is_ascii_digit()))
}

fn valid_token(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Minimal client for the two existing user-scoped endpoints. Built once with
/// redirects disabled, so the bearer is never sent to another origin.
#[derive(Clone)]
pub(crate) struct FormVerifier {
    project_url: String,
    publishable_key: String,
    client: reqwest::Client,
}

impl FormVerifier {
    pub(crate) fn new(project_url: &str, publishable_key: &str) -> Self {
        Self {
            project_url: project_url.trim_end_matches('/').to_owned(),
            publishable_key: publishable_key.to_owned(),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("static reqwest client configuration"),
        }
    }

    /// Create or replace the DNS challenge for one exact owned site and hostname.
    pub(crate) async fn begin(
        &self,
        enabled: bool,
        headers: &HeaderMap,
        input: &BeginInput,
    ) -> Result<Value, FormError> {
        if !enabled {
            return Err(NOT_ENABLED);
        }
        let authorization = authorization(headers)?;
        if !valid_hostname(&input.hostname) {
            return Err(INVALID);
        }
        let response = self
            .client
            .post(format!(
                "{}/rest/v1/rpc/begin_form_host_verification",
                self.project_url
            ))
            .header("apikey", &self.publishable_key)
            .header(header::AUTHORIZATION, authorization)
            .timeout(Duration::from_secs(10))
            .json(&json!({"p_website_id": input.website_id, "p_hostname": input.hostname}))
            .send()
            .await
            .map_err(|_| BEGIN_UNKNOWN)?;
        let status = response.status();
        let body = response.bytes().await.map_err(|_| BEGIN_UNKNOWN)?;
        if status == StatusCode::OK {
            return begin_result(&body, &input.hostname).ok_or(UNAVAILABLE);
        }
        Err(map_begin_error(status, &body))
    }

    /// Check the published TXT record through the existing `form-verify` function.
    pub(crate) async fn confirm(
        &self,
        enabled: bool,
        headers: &HeaderMap,
        input: &ConfirmInput,
    ) -> Result<Value, FormError> {
        if !enabled {
            return Err(NOT_ENABLED);
        }
        let authorization = authorization(headers)?;
        if !valid_token(&input.token) {
            return Err(INVALID);
        }
        let response = self
            .client
            .post(format!("{}/functions/v1/form-verify", self.project_url))
            .header("apikey", &self.publishable_key)
            .header(header::AUTHORIZATION, authorization)
            .timeout(Duration::from_secs(30))
            .json(&json!({"host_id": input.host_id, "token": input.token}))
            .send()
            .await
            .map_err(|_| CONFIRM_UNKNOWN)?;
        // Upstream bodies are never read into output or errors. Only the status
        // selects a fixed code, so the response text cannot leak.
        match response.status() {
            StatusCode::OK => Ok(json!({
                "host_id": input.host_id,
                "verified": true,
                "status": "verified",
            })),
            StatusCode::BAD_REQUEST => Err(INVALID),
            StatusCode::UNAUTHORIZED => Err(UNAUTHORIZED),
            StatusCode::NOT_FOUND => Err(HOST_NOT_FOUND),
            StatusCode::UNPROCESSABLE_ENTITY => Err(DNS_NOT_FOUND),
            StatusCode::CONFLICT => Err(CHALLENGE_CHANGED),
            _ => Err(CONFIRM_UNKNOWN),
        }
    }
}

fn authorization(headers: &HeaderMap) -> Result<&axum::http::HeaderValue, FormError> {
    headers.get(header::AUTHORIZATION).ok_or(UNAUTHORIZED)
}

/// Validate the RPC's success shape before returning it to the caller.
fn begin_result(body: &[u8], hostname: &str) -> Option<Value> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let host_id = value.get("host_id")?.as_str()?;
    Uuid::parse_str(host_id).ok()?;
    if value.get("hostname")?.as_str()? != hostname {
        return None;
    }
    if value.get("txt_name")?.as_str()? != format!("_htp-verification.{hostname}") {
        return None;
    }
    let txt_value = value.get("txt_value")?.as_str()?;
    let token = txt_value.strip_prefix("htp-verification=")?;
    if !valid_token(token) {
        return None;
    }
    Some(json!({
        "host_id": host_id,
        "hostname": hostname,
        "txt_name": format!("_htp-verification.{hostname}"),
        "txt_value": txt_value,
        "expires_in_hours": 24,
        "next_step": "Publish txt_value as a TXT record at txt_name, wait for DNS to propagate, then call confirm_form_host_verification with host_id and the token from txt_value.",
    }))
}

/// Map PostgREST failures by fixed substrings of the database raise message.
/// The upstream text is never returned.
fn map_begin_error(status: StatusCode, body: &[u8]) -> FormError {
    match status {
        StatusCode::UNAUTHORIZED => UNAUTHORIZED,
        StatusCode::FORBIDDEN | StatusCode::NOT_FOUND => NOT_FOUND,
        StatusCode::BAD_REQUEST => {
            let message = serde_json::from_slice::<Value>(body)
                .ok()
                .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_owned))
                .unwrap_or_default();
            if message.contains("form_host_rate_limited") {
                RATE_LIMITED
            } else if message.contains("form_host_account_limit")
                || message.contains("form_host_limit")
            {
                HOST_LIMIT
            } else if message.contains("Website not found") {
                NOT_FOUND
            } else if message.contains("Invalid hostname") {
                INVALID
            } else {
                UNAVAILABLE
            }
        }
        _ => BEGIN_UNKNOWN,
    }
}

/// Convert a result to MCP output. Errors carry only the fixed code and message.
pub(crate) fn tool_result(result: Result<Value, FormError>) -> CallToolResult {
    match result {
        Ok(value) => CallToolResult::structured(value),
        Err(error) => {
            let mut result = CallToolResult::structured(json!({
                "code": error.code,
                "error": error.message,
            }));
            result.is_error = Some(true);
            result
        }
    }
}

/// Shared state for both entry points. `enabled` is read once at startup.
#[derive(Clone)]
pub(crate) struct FormVerificationState {
    pub(crate) verifier: FormVerifier,
    pub(crate) enabled: bool,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RestBeginBody {
    hostname: String,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RestConfirmBody {
    token: String,
}

/// Authenticated REST entry points. `lib.rs` merges this router behind
/// `auth::require_user`, the same as the websites routes.
///   POST /websites/{id}/forms/host-verifications   body {"hostname": "..."}
///   POST /forms/host-verifications/{host_id}/confirm  body {"token": "..."}
pub(crate) fn router(state: FormVerificationState) -> Router {
    Router::new()
        .route("/websites/{id}/forms/host-verifications", post(rest_begin))
        .route(
            "/forms/host-verifications/{host_id}/confirm",
            post(rest_confirm),
        )
        .with_state(state)
}

async fn rest_begin(
    State(state): State<FormVerificationState>,
    Path(website_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<RestBeginBody>,
) -> Response {
    let input = BeginInput {
        website_id,
        hostname: body.hostname,
    };
    rest_response(state.verifier.begin(state.enabled, &headers, &input).await)
}

async fn rest_confirm(
    State(state): State<FormVerificationState>,
    Path(host_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<RestConfirmBody>,
) -> Response {
    let input = ConfirmInput {
        host_id,
        token: body.token,
    };
    rest_response(
        state
            .verifier
            .confirm(state.enabled, &headers, &input)
            .await,
    )
}

/// Fixed status per code. Disabled is reported as 404 so it reveals nothing.
/// Every response is no-store because begin returns a challenge token.
fn rest_response(result: Result<Value, FormError>) -> Response {
    let (status, body) = match result {
        Ok(value) => (StatusCode::OK, value),
        Err(error) => {
            let status = match error.code {
                "forms_verification_disabled" | "website_not_found" | "host_not_found" => {
                    StatusCode::NOT_FOUND
                }
                "unauthorized" => StatusCode::UNAUTHORIZED,
                "invalid_request" => StatusCode::BAD_REQUEST,
                "rate_limited" => StatusCode::TOO_MANY_REQUESTS,
                "host_limit" | "challenge_expired_or_changed" => StatusCode::CONFLICT,
                "dns_record_not_verified" => StatusCode::UNPROCESSABLE_ENTITY,
                _ => StatusCode::SERVICE_UNAVAILABLE,
            };
            (status, json!({"code": error.code, "error": error.message}))
        }
    };
    (status, [(header::CACHE_CONTROL, "no-store")], Json(body)).into_response()
}

/// MCP tools for the same operations as the REST routes. They are merged into
/// the server router only when the flag is on, and live here so the frozen
/// contract inventory (scripts/check-plugin-contract.mjs, which scans mcp.rs)
/// still describes only the default tool set.
#[tool_router(router = forms_tool_router, vis = "pub(crate)")]
impl crate::mcp::WebsiteMcp {
    #[tool(
        description = "Begin Forms DNS verification for one owned website and exact hostname. Returns the TXT name and value once; publish it, wait for DNS, then call confirm_form_host_verification. If the outcome is unknown, reconcile the site's verification state before any further action. Default-off; requires server enablement and database grants.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false
        )
    )]
    async fn begin_form_host_verification(
        &self,
        rmcp::handler::server::wrapper::Parameters(input): rmcp::handler::server::wrapper::Parameters<crate::form_verification::BeginInput>,
        rmcp::handler::server::tool::Extension(parts): rmcp::handler::server::tool::Extension<
            axum::http::request::Parts,
        >,
    ) -> CallToolResult {
        crate::form_verification::tool_result(
            self.forms
                .verifier
                .begin(self.forms.enabled, &parts.headers, &input)
                .await,
        )
    }
    #[tool(
        description = "Confirm Forms DNS verification after the TXT record is published. Checks the exact record and marks the owned hostname verified. If the outcome is unknown, reconcile the verification state before any further action. Default-off; requires server enablement and database grants.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true
        )
    )]
    async fn confirm_form_host_verification(
        &self,
        rmcp::handler::server::wrapper::Parameters(input): rmcp::handler::server::wrapper::Parameters<crate::form_verification::ConfirmInput>,
        rmcp::handler::server::tool::Extension(parts): rmcp::handler::server::tool::Extension<
            axum::http::request::Parts,
        >,
    ) -> CallToolResult {
        crate::form_verification::tool_result(
            self.forms
                .verifier
                .confirm(self.forms.enabled, &parts.headers, &input)
                .await,
        )
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn unknown_outcome_guidance_is_conservative() {
        for message in [super::BEGIN_UNKNOWN.message, super::CONFIRM_UNKNOWN.message] {
            let lower = message.to_ascii_lowercase();
            for banned in ["again", "retry", "replace", "safe", "rotat"] {
                assert!(!lower.contains(banned), "{banned} in: {message}");
            }
        }
    }

    use super::*;
    use axum::{Json, Router, routing::any};

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const HOST: &str = "00000000-0000-0000-0000-000000000006";
    const SITE: &str = "00000000-0000-0000-0000-000000000001";

    fn bearer(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", value.parse().unwrap());
        headers
    }

    fn begin_input(hostname: &str) -> BeginInput {
        BeginInput {
            website_id: Uuid::parse_str(SITE).unwrap(),
            hostname: hostname.to_owned(),
        }
    }

    async fn serve(app: Router) -> FormVerifier {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        FormVerifier::new(&origin, "test-publishable")
    }

    #[test]
    fn hostname_is_exact_and_fail_closed() {
        for ok in ["www.example.com", "a.bc", "x-1.example.test"] {
            assert!(valid_hostname(ok), "{ok}");
        }
        for bad in [
            "",
            "example",
            "WWW.example.com",
            "*.example.com",
            "example.com.",
            "http://example.com",
            "example.com/path",
            "example.com:443",
            "-bad.example.com",
            "bad-.example.com",
            "bad..example.com",
            "192.168.0.1",
            "a b.example.com",
        ] {
            assert!(!valid_hostname(bad), "{bad}");
        }
        assert!(!valid_token("ABCDEF"));
        assert!(!valid_token(&"a".repeat(63)));
        assert!(valid_token(TOKEN));
    }

    #[tokio::test]
    async fn default_off_never_calls_upstream() {
        // The unreachable origin would fail with a transport error if called.
        let verifier = FormVerifier::new("http://127.0.0.1:1", "test-publishable");
        let headers = bearer("Bearer owner-token");
        assert_eq!(
            verifier
                .begin(false, &headers, &begin_input("www.example.com"))
                .await,
            Err(NOT_ENABLED)
        );
        let confirm = ConfirmInput {
            host_id: Uuid::parse_str(HOST).unwrap(),
            token: TOKEN.to_owned(),
        };
        assert_eq!(
            verifier.confirm(false, &headers, &confirm).await,
            Err(NOT_ENABLED)
        );
    }

    #[tokio::test]
    async fn missing_bearer_and_invalid_input_fail_before_upstream() {
        let verifier = FormVerifier::new("http://127.0.0.1:1", "test-publishable");
        assert_eq!(
            verifier
                .begin(true, &HeaderMap::new(), &begin_input("www.example.com"))
                .await,
            Err(UNAUTHORIZED)
        );
        let headers = bearer("Bearer owner-token");
        assert_eq!(
            verifier
                .begin(true, &headers, &begin_input("Bad.example.com"))
                .await,
            Err(INVALID)
        );
        let short = ConfirmInput {
            host_id: Uuid::parse_str(HOST).unwrap(),
            token: "short".to_owned(),
        };
        assert_eq!(verifier.confirm(true, &headers, &short).await, Err(INVALID));
    }

    #[tokio::test]
    async fn begin_forwards_owner_bearer_and_returns_the_exact_challenge() {
        let app = Router::new().route(
            "/{*path}",
            any(|headers: HeaderMap, body: axum::body::Bytes| async move {
                assert_eq!(headers["authorization"], "Bearer owner-token");
                assert_eq!(headers["apikey"], "test-publishable");
                let body: Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(body["p_website_id"], SITE);
                assert_eq!(body["p_hostname"], "www.example.com");
                assert!(body.get("p_owner_id").is_none());
                (
                    StatusCode::OK,
                    Json(json!({
                        "host_id": HOST,
                        "hostname": "www.example.com",
                        "txt_name": "_htp-verification.www.example.com",
                        "txt_value": format!("htp-verification={TOKEN}"),
                    })),
                )
            }),
        );
        let verifier = serve(app).await;
        let result = verifier
            .begin(
                true,
                &bearer("Bearer owner-token"),
                &begin_input("www.example.com"),
            )
            .await
            .unwrap();
        assert_eq!(result["host_id"], HOST);
        assert_eq!(result["txt_name"], "_htp-verification.www.example.com");
        assert_eq!(result["txt_value"], format!("htp-verification={TOKEN}"));
        assert_eq!(result["expires_in_hours"], 24);
    }

    #[tokio::test]
    async fn begin_rejects_mismatched_success_shape() {
        let app = Router::new().route(
            "/{*path}",
            any(|| async {
                Json(json!({
                    "host_id": HOST,
                    "hostname": "other.example.com",
                    "txt_name": "_htp-verification.other.example.com",
                    "txt_value": format!("htp-verification={TOKEN}"),
                }))
            }),
        );
        let verifier = serve(app).await;
        assert_eq!(
            verifier
                .begin(
                    true,
                    &bearer("Bearer owner-token"),
                    &begin_input("www.example.com")
                )
                .await,
            Err(UNAVAILABLE)
        );
    }

    #[tokio::test]
    async fn begin_maps_database_refusals_without_upstream_text() {
        let cases = [
            (
                StatusCode::FORBIDDEN,
                json!({"message":"Website not found"}),
                NOT_FOUND,
            ),
            (
                StatusCode::BAD_REQUEST,
                json!({"message":"form_host_rate_limited"}),
                RATE_LIMITED,
            ),
            (
                StatusCode::BAD_REQUEST,
                json!({"message":"form_host_account_limit"}),
                HOST_LIMIT,
            ),
            (
                StatusCode::BAD_REQUEST,
                json!({"message":"form_host_limit"}),
                HOST_LIMIT,
            ),
            (
                StatusCode::BAD_REQUEST,
                json!({"message":"Invalid hostname"}),
                INVALID,
            ),
            (
                StatusCode::BAD_REQUEST,
                json!({"message":"PRIVATE DETAIL"}),
                UNAVAILABLE,
            ),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"message":"PRIVATE DETAIL"}),
                BEGIN_UNKNOWN,
            ),
        ];
        for (status, body, expected) in cases {
            let app = Router::new().route(
                "/{*path}",
                any(move || {
                    let body = body.clone();
                    async move { (status, Json(body)) }
                }),
            );
            let verifier = serve(app).await;
            let error = verifier
                .begin(
                    true,
                    &bearer("Bearer owner-token"),
                    &begin_input("www.example.com"),
                )
                .await
                .unwrap_err();
            assert_eq!(error, expected);
            assert!(!format!("{error:?}").contains("PRIVATE DETAIL"));
        }
    }

    #[tokio::test]
    async fn confirm_forwards_owner_bearer_and_returns_verified() {
        let app = Router::new().route(
            "/{*path}",
            any(|headers: HeaderMap, body: axum::body::Bytes| async move {
                assert_eq!(headers["authorization"], "Bearer owner-token");
                assert_eq!(headers["apikey"], "test-publishable");
                let body: Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(body["host_id"], HOST);
                assert_eq!(body["token"], TOKEN);
                (StatusCode::OK, Json(json!({"ok": true})))
            }),
        );
        let verifier = serve(app).await;
        let input = ConfirmInput {
            host_id: Uuid::parse_str(HOST).unwrap(),
            token: TOKEN.to_owned(),
        };
        let result = verifier
            .confirm(true, &bearer("Bearer owner-token"), &input)
            .await
            .unwrap();
        assert_eq!(result["verified"], true);
        assert_eq!(result["status"], "verified");
    }

    #[tokio::test]
    async fn confirm_error_codes_are_fixed_and_unknown_on_server_failure() {
        let cases = [
            (StatusCode::UNPROCESSABLE_ENTITY, DNS_NOT_FOUND),
            (StatusCode::CONFLICT, CHALLENGE_CHANGED),
            (StatusCode::NOT_FOUND, HOST_NOT_FOUND),
            (StatusCode::UNAUTHORIZED, UNAUTHORIZED),
            (StatusCode::BAD_REQUEST, INVALID),
            (StatusCode::SERVICE_UNAVAILABLE, CONFIRM_UNKNOWN),
        ];
        for (status, expected) in cases {
            let app = Router::new().route(
                "/{*path}",
                any(move || async move { (status, Json(json!({"error":"PRIVATE DETAIL"}))) }),
            );
            let verifier = serve(app).await;
            let input = ConfirmInput {
                host_id: Uuid::parse_str(HOST).unwrap(),
                token: TOKEN.to_owned(),
            };
            let error = verifier
                .confirm(true, &bearer("Bearer owner-token"), &input)
                .await
                .unwrap_err();
            assert_eq!(error, expected, "{status}");
            assert!(!format!("{error:?}").contains("PRIVATE DETAIL"));
        }
    }

    #[tokio::test]
    async fn redirects_are_not_followed_with_the_bearer() {
        let target = Router::new().route(
            "/{*path}",
            any(|headers: HeaderMap| async move {
                // A leaked bearer would reach this handler.
                assert!(
                    !headers.contains_key("authorization"),
                    "bearer followed redirect"
                );
                (StatusCode::OK, Json(json!({"host_id": HOST})))
            }),
        );
        let target_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_origin = format!("http://{}", target_listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(target_listener, target).await.unwrap() });
        let location = format!("{target_origin}/leak");
        let redirect = Router::new().route(
            "/{*path}",
            any(move || {
                let location = location.clone();
                async move {
                    let mut headers = HeaderMap::new();
                    headers.insert("location", location.parse().unwrap());
                    (StatusCode::FOUND, headers)
                }
            }),
        );
        let verifier = serve(redirect).await;
        let input = ConfirmInput {
            host_id: Uuid::parse_str(HOST).unwrap(),
            token: TOKEN.to_owned(),
        };
        assert_eq!(
            verifier
                .confirm(true, &bearer("Bearer owner-token"), &input)
                .await,
            Err(CONFIRM_UNKNOWN)
        );
    }

    fn rest_app(enabled: bool, base: &str) -> Router {
        router(FormVerificationState {
            verifier: FormVerifier::new(base, "test-publishable"),
            enabled,
        })
    }

    #[tokio::test]
    async fn rest_disabled_is_not_found_and_never_reaches_upstream() {
        use tower::ServiceExt;
        let app = rest_app(false, "http://127.0.0.1:1");
        let request = axum::http::Request::builder()
            .method("POST")
            .uri(format!("/websites/{SITE}/forms/host-verifications"))
            .header("authorization", "Bearer owner-token")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(r#"{"hostname":"www.example.com"}"#))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }

    #[tokio::test]
    async fn rest_begin_and_confirm_forward_owner_bearer_and_map_outcomes() {
        use tower::ServiceExt;
        let upstream = Router::new()
            .route(
                "/rest/v1/rpc/begin_form_host_verification",
                any(|headers: HeaderMap| async move {
                    assert_eq!(headers["authorization"], "Bearer owner-token");
                    Json(json!({
                        "host_id": HOST,
                        "hostname": "www.example.com",
                        "txt_name": "_htp-verification.www.example.com",
                        "txt_value": format!("htp-verification={TOKEN}"),
                    }))
                }),
            )
            .route(
                "/functions/v1/form-verify",
                any(|headers: HeaderMap| async move {
                    assert_eq!(headers["authorization"], "Bearer owner-token");
                    (
                        StatusCode::UNPROCESSABLE_ENTITY,
                        Json(json!({"error":"verification_failed"})),
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let app = rest_app(true, &base);

        let begin = axum::http::Request::builder()
            .method("POST")
            .uri(format!("/websites/{SITE}/forms/host-verifications"))
            .header("authorization", "Bearer owner-token")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(r#"{"hostname":"www.example.com"}"#))
            .unwrap();
        let response = app.clone().oneshot(begin).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = axum::body::to_bytes(response.into_body(), 1 << 16)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["txt_value"], format!("htp-verification={TOKEN}"));

        let confirm = axum::http::Request::builder()
            .method("POST")
            .uri(format!("/forms/host-verifications/{HOST}/confirm"))
            .header("authorization", "Bearer owner-token")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(format!(r#"{{"token":"{TOKEN}"}}"#)))
            .unwrap();
        let response = app.oneshot(confirm).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = axum::body::to_bytes(response.into_body(), 1 << 16)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["code"], "dns_record_not_verified");
        assert!(!body.to_string().contains(TOKEN));
    }

    #[tokio::test]
    async fn rest_rejects_unknown_body_fields() {
        use tower::ServiceExt;
        let app = rest_app(true, "http://127.0.0.1:1");
        let request = axum::http::Request::builder()
            .method("POST")
            .uri(format!("/websites/{SITE}/forms/host-verifications"))
            .header("authorization", "Bearer owner-token")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(
                r#"{"hostname":"www.example.com","owner_id":"x"}"#,
            ))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert!(response.status().is_client_error());
    }

    #[test]
    fn mcp_forms_tools_are_listed_only_when_enabled() {
        use crate::mcp::website_tool_router;
        let names = [
            "begin_form_host_verification",
            "confirm_form_host_verification",
        ];
        let off = website_tool_router(false);
        let on = website_tool_router(true);
        for name in names {
            assert!(off.get(name).is_none(), "{name} listed while disabled");
            assert!(on.get(name).is_some(), "{name} missing while enabled");
        }
        assert_eq!(off.list_all().len() + names.len(), on.list_all().len());
    }

    #[test]
    fn tool_errors_carry_only_fixed_codes() {
        let result = tool_result(Err(RATE_LIMITED));
        assert_eq!(result.is_error, Some(true));
        let value = result.structured_content.unwrap();
        assert_eq!(value["code"], "rate_limited");
        assert!(!value.to_string().contains("token"));
    }
}
