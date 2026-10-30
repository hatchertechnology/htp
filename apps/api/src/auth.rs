//! Supabase access-token validation using the project's public signing keys.

use std::{sync::Arc, time::Duration};

use axum::{
    Json,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use serde::Deserialize;
use serde_json::json;
use tokio::{sync::Mutex, time::Instant};
use uuid::Uuid;

/// The Supabase project used by this application.
pub const SUPABASE_URL: &str = "https://raxuvdbdfmmtpqjcafcq.supabase.co";
const CACHE_TTL: Duration = Duration::from_secs(300);
const REFRESH_INTERVAL: Duration = Duration::from_secs(30);

/// Shared verifier and public-key cache. Contains no private signing keys.
#[derive(Clone)]
pub struct SupabaseAuth {
    issuer: String,
    client: reqwest::Client,
    cache: Arc<Mutex<KeyCache>>,
}

#[derive(Default)]
struct KeyCache {
    fetched_at: Option<Instant>,
    keys: JwkSet,
}

/// Identity verified by the authentication middleware.
#[derive(Clone, Debug)]
pub struct AuthenticatedUser {
    pub id: Uuid,
}

#[derive(Deserialize)]
struct Claims {
    sub: Uuid,
    role: String,
    is_anonymous: bool,
}

impl SupabaseAuth {
    /// Create a verifier for a trusted Supabase project URL.
    /// Only configure URLs controlled by the operator, never by a request.
    #[must_use]
    pub fn new(project_url: &str) -> Self {
        Self {
            issuer: format!("{}/auth/v1", project_url.trim_end_matches('/')),
            client: reqwest::Client::new(),
            cache: Arc::default(),
        }
    }

    async fn verify(&self, token: &str) -> Result<AuthenticatedUser, AuthError> {
        let jwt_header = decode_header(token).map_err(|_| AuthError::InvalidToken)?;
        // Never accept symmetric keys or let an untrusted token select a key URL.
        let expected_alg = match jwt_header.alg {
            Algorithm::ES256 => jsonwebtoken::jwk::KeyAlgorithm::ES256,
            Algorithm::RS256 => jsonwebtoken::jwk::KeyAlgorithm::RS256,
            _ => return Err(AuthError::InvalidToken),
        };
        let kid = jwt_header.kid.ok_or(AuthError::InvalidToken)?;
        let key = {
            let mut cache = self.cache.lock().await;
            let age = cache.fetched_at.map(|instant| instant.elapsed());
            let expired = age.is_none_or(|age| age >= CACHE_TTL);
            let unknown_key = cache.keys.find(&kid).is_none();
            let can_refresh = age.is_none_or(|age| age >= REFRESH_INTERVAL);
            if expired || (unknown_key && can_refresh) {
                let keys = self
                    .client
                    .get(format!("{}/.well-known/jwks.json", self.issuer))
                    .timeout(Duration::from_secs(5))
                    .send()
                    .await
                    .map_err(|_| AuthError::Unavailable)?
                    .error_for_status()
                    .map_err(|_| AuthError::Unavailable)?
                    .json::<JwkSet>()
                    .await
                    .map_err(|_| AuthError::Unavailable)?;
                cache.keys = keys;
                cache.fetched_at = Some(Instant::now());
            }
            let jwk = cache.keys.find(&kid).ok_or(AuthError::InvalidToken)?;
            if jwk.common.key_algorithm != Some(expected_alg)
                || jwk
                    .common
                    .public_key_use
                    .as_ref()
                    .is_some_and(|usage| *usage != jsonwebtoken::jwk::PublicKeyUse::Signature)
                || jwk
                    .common
                    .key_operations
                    .as_ref()
                    .is_some_and(|operations| {
                        !operations.contains(&jsonwebtoken::jwk::KeyOperations::Verify)
                    })
            {
                return Err(AuthError::InvalidToken);
            }
            DecodingKey::from_jwk(jwk).map_err(|_| AuthError::InvalidToken)?
        };

        let mut validation = Validation::new(jwt_header.alg);
        validation.set_issuer(&[&self.issuer]);
        validation.set_audience(&["authenticated"]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        validation.validate_nbf = true;
        validation.leeway = 0;
        let claims = decode::<Claims>(token, &key, &validation)
            .map_err(|_| AuthError::InvalidToken)?
            .claims;
        if claims.role != "authenticated" || claims.is_anonymous || claims.sub.is_nil() {
            return Err(AuthError::InvalidToken);
        }
        Ok(AuthenticatedUser { id: claims.sub })
    }
}

pub(crate) async fn require_user(
    State(auth): State<SupabaseAuth>,
    mut request: Request,
    next: Next,
) -> Result<Response, AuthError> {
    let token = bearer_token(request.headers())?;
    let user = auth.verify(token).await?;
    request.extensions_mut().insert(user);
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

fn bearer_token(headers: &HeaderMap) -> Result<&str, AuthError> {
    if headers.get_all(header::AUTHORIZATION).iter().count() != 1 {
        return Err(AuthError::InvalidToken);
    }
    let (scheme, token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split_once(' '))
        .ok_or(AuthError::InvalidToken)?;
    if !scheme.eq_ignore_ascii_case("bearer")
        || token.is_empty()
        || token.len() > 8192
        || token.bytes().any(|byte| byte.is_ascii_whitespace())
    {
        return Err(AuthError::InvalidToken);
    }
    Ok(token)
}

pub(crate) enum AuthError {
    InvalidToken,
    Unavailable,
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::InvalidToken => (
                StatusCode::UNAUTHORIZED,
                "A valid Supabase user access token is required",
            ),
            Self::Unavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "Authentication service is temporarily unavailable",
            ),
        };
        let mut response = (status, Json(json!({"error": message}))).into_response();
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        if status == StatusCode::UNAUTHORIZED {
            response.headers_mut().insert(
                header::WWW_AUTHENTICATE,
                HeaderValue::from_static("Bearer realm=\"htp\""),
            );
        }
        response
    }
}
