//! Native provider consent. The browser first navigates to the returned API URL,
//! allowing a host-only Lax cookie without credentialed cross-origin fetches.
use crate::auth::AuthenticatedUser;
use axum::{
    Extension, Json, Router,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
const ANALYTICS: &str = "https://www.googleapis.com/auth/analytics.readonly";
const SEARCH: &str = "https://www.googleapis.com/auth/webmasters.readonly";
const BUSINESS: &str = "https://www.googleapis.com/auth/business.manage";
#[derive(Clone)]
struct Config {
    api: String,
    dashboard: String,
    project: String,
    service: String,
    google: Provider,
    bing: Provider,
}
#[derive(Clone)]
struct Provider {
    id: String,
    secret: String,
    key: Vec<u8>,
}
#[derive(Clone, Default)]
pub(crate) struct OAuth {
    config: Option<Arc<Config>>,
    tickets: Arc<Mutex<HashMap<String, Pending>>>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Pending {
    user: String,
    provider: String,
    state: String,
    verifier: String,
    until: i64,
    fence: ConsentFence,
}
#[derive(Clone, Serialize, Deserialize)]
struct ConsentFence {
    epoch: uuid::Uuid,
    generation: Option<uuid::Uuid>,
}
async fn consent_rpc(config: &Config, operation: &str, body: Value) -> Option<Value> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .ok()?;
    let mut response = client
        .post(format!("{}/rest/v1/rpc/{operation}", config.project))
        .header("apikey", &config.service)
        .bearer_auth(&config.service)
        .json(&body)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > 65536 {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).ok()
}
const OWNER_PENDING_LIMIT: usize = 8;
fn insert_pending(
    tickets: &mut HashMap<String, Pending>,
    ticket: String,
    pending: Pending,
) -> bool {
    tickets.retain(|_, p| p.until > now());
    if tickets.len() >= 1024
        || tickets.values().filter(|p| p.user == pending.user).count() >= OWNER_PENDING_LIMIT
    {
        return false;
    }
    tickets.insert(ticket, pending);
    true
}
fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|s| !s.is_empty())
}
fn origin(raw: String) -> Option<String> {
    let url = reqwest::Url::parse(&raw).ok()?;
    (url.scheme() == "https" && url.origin().ascii_serialization() == raw).then_some(raw)
}
impl OAuth {
    pub(crate) fn from_env() -> Self {
        // No credentials are read when rollout is held.
        if env("HTP_ROLLOUT_PROVIDER_OAUTH").as_deref() != Some("true") {
            return Self::default();
        }
        let load = || -> Option<Config> {
            let provider = |prefix: &str| -> Option<Provider> {
                let key = STANDARD
                    .decode(env(&format!("{prefix}_COOKIE_KEY"))?)
                    .ok()?;
                if key.len() != 32 {
                    return None;
                }
                Some(Provider {
                    id: env(&format!("{prefix}_CLIENT_ID"))?,
                    secret: env(&format!("{prefix}_CLIENT_SECRET"))?,
                    key,
                })
            };
            Some(Config {
                api: origin(env("HTP_PROVIDER_OAUTH_API_ORIGIN")?)?,
                dashboard: origin(env(crate::dashboard_cors::ORIGIN_ENV)?)?,
                project: origin(env("SUPABASE_URL")?)?,
                service: env("SUPABASE_SERVICE_ROLE_KEY")?,
                google: provider("GOOGLE")?,
                bing: provider("BING")?,
            })
        };
        Self {
            config: load().map(Arc::new),
            ..Self::default()
        }
    }
    pub(crate) fn protected(&self) -> Router {
        Router::new()
            .route("/providers/{provider}/connect", post(connect))
            .with_state(self.clone())
    }
    pub(crate) fn public(&self) -> Router {
        Router::new()
            .route("/auth/{provider}/start", get(start))
            .route("/auth/{provider}/callback", get(callback))
            .with_state(self.clone())
    }
}
fn random() -> String {
    let mut bytes = [0; 32];
    SystemRandom::new().fill(&mut bytes).expect("OS random");
    URL_SAFE_NO_PAD.encode(bytes)
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn cookie(provider: &str) -> String {
    format!("htp_{provider}_state")
}
fn provider<'a>(config: &'a Config, name: &str) -> Option<&'a Provider> {
    match name {
        "google" => Some(&config.google),
        "bing" => Some(&config.bing),
        _ => None,
    }
}
fn private(mut response: Response) -> Response {
    for (name, value) in [
        ("cache-control", "private, no-store"),
        ("referrer-policy", "no-referrer"),
    ] {
        response.headers_mut().insert(name, value.parse().unwrap());
    }
    response
}
fn held() -> Response {
    private(
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"code":"provider_oauth_unavailable"})),
        )
            .into_response(),
    )
}
async fn connect(
    State(oauth): State<OAuth>,
    Path(name): Path<String>,
    Extension(user): Extension<AuthenticatedUser>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let Some(config) = &oauth.config else {
        return held();
    };
    if provider(config, &name).is_none() {
        return private(StatusCode::NOT_FOUND.into_response());
    }
    if headers.get_all("origin").iter().count() != 1
        || headers.get("origin").and_then(|v| v.to_str().ok()) != Some(&config.dashboard)
    {
        return private(StatusCode::FORBIDDEN.into_response());
    }
    if !body.is_empty() {
        return private(StatusCode::BAD_REQUEST.into_response());
    }
    // Never hold the process ledger lock across database I/O. Concurrent issuance
    // is bounded by the final locked insertion, including in-flight snapshots.
    let Some(fence) = consent_rpc(
        config,
        "begin_provider_consent",
        json!({"p_owner_id":user.id,"p_provider":name}),
    )
    .await
    .and_then(|v| serde_json::from_value::<ConsentFence>(v).ok()) else {
        return held();
    };
    let pending = Pending {
        fence,
        user: user.id.to_string(),
        provider: name.clone(),
        state: random(),
        verifier: random(),
        until: now() + 600_000,
    };
    let ticket = random();
    let mut tickets = oauth.tickets.lock().unwrap();
    if !insert_pending(&mut tickets, format!("ticket:{ticket}"), pending) {
        return held();
    }
    private(
        Json(json!({"url":format!("{}/auth/{name}/start?ticket={ticket}", config.api)}))
            .into_response(),
    )
}
fn query(raw: Option<String>) -> Option<HashMap<String, String>> {
    let raw = raw.unwrap_or_default();
    if raw.len() > 16384 {
        return None;
    }
    let mut values = HashMap::new();
    for (k, v) in form_urlencoded::parse(raw.as_bytes()) {
        if values.insert(k.into_owned(), v.into_owned()).is_some() {
            return None;
        }
    }
    Some(values)
}
async fn start(
    State(oauth): State<OAuth>,
    Path(name): Path<String>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Response {
    let Some(config) = &oauth.config else {
        return held();
    };
    let Some(settings) = provider(config, &name) else {
        return private(StatusCode::NOT_FOUND.into_response());
    };
    // Launch tickets may only be used by navigation from our trusted dashboard.
    // Otherwise sharing an owner-bound launch URL would enable login CSRF.
    let trusted_referrer = headers.get_all("referer").iter().count() == 1
        && headers
            .get("referer")
            .and_then(|h| h.to_str().ok())
            .and_then(|v| reqwest::Url::parse(v).ok())
            .is_some_and(|u| {
                u.origin().ascii_serialization() == config.dashboard
                    && u.username().is_empty()
                    && u.password().is_none()
            });
    if !trusted_referrer {
        return private(StatusCode::FORBIDDEN.into_response());
    }
    let Some(params) = query(raw) else {
        return private(StatusCode::BAD_REQUEST.into_response());
    };
    if params.len() != 1 {
        return private(StatusCode::BAD_REQUEST.into_response());
    }
    let pending = {
        let mut tickets = oauth.tickets.lock().unwrap();
        let pending = params
            .get("ticket")
            .and_then(|t| tickets.remove(&format!("ticket:{t}")));
        let Some(pending) = pending.filter(|p| p.until > now() && p.provider == name) else {
            return private(StatusCode::BAD_REQUEST.into_response());
        };
        tickets.insert(format!("state:{}", pending.state), pending.clone());
        pending
    };
    let mut url = reqwest::Url::parse(if name == "google" {
        "https://accounts.google.com/o/oauth2/v2/auth"
    } else {
        "https://www.bing.com/webmasters/oauth/authorize"
    })
    .unwrap();
    let requested_scope = if name == "google" {
        format!("{ANALYTICS} {SEARCH}")
    } else {
        "webmaster.read".to_owned()
    };
    url.query_pairs_mut().extend_pairs([
        ("response_type", "code"),
        ("client_id", settings.id.as_str()),
        (
            "redirect_uri",
            &format!("{}/auth/{name}/callback", config.api),
        ),
        ("scope", requested_scope.as_str()),
        ("state", &pending.state),
    ]);
    if name == "google" {
        url.query_pairs_mut().extend_pairs([
            ("access_type", "offline"),
            ("prompt", "consent"),
            ("code_challenge_method", "S256"),
            (
                "code_challenge",
                &URL_SAFE_NO_PAD.encode(Sha256::digest(pending.verifier.as_bytes())),
            ),
        ]);
    }
    let Ok(sealed) = seal(
        &serde_json::to_value(pending).unwrap(),
        &settings.key,
        &cookie(&name),
    ) else {
        return held();
    };
    let mut response = Redirect::to(url.as_str()).into_response();
    response.headers_mut().append(
        "set-cookie",
        format!(
            "{}={sealed}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600",
            cookie(&name)
        )
        .parse()
        .unwrap(),
    );
    private(response)
}
// Wire format matches Nitro sealed-cookie.ts: IV || tag || ciphertext, base64url.
pub(crate) fn seal(value: &Value, key: &[u8], purpose: &str) -> Result<String, ()> {
    let key =
        aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, key).map_err(|_| ())?);
    let mut iv = [0; 12];
    SystemRandom::new().fill(&mut iv).map_err(|_| ())?;
    let mut data = serde_json::to_vec(value).map_err(|_| ())?;
    let tag = key
        .seal_in_place_separate_tag(
            aead::Nonce::assume_unique_for_key(iv),
            aead::Aad::from(purpose.as_bytes()),
            &mut data,
        )
        .map_err(|_| ())?;
    let mut output = iv.to_vec();
    output.extend_from_slice(tag.as_ref());
    output.extend(data);
    Ok(URL_SAFE_NO_PAD.encode(output))
}
pub(crate) fn unseal(value: &str, key: &[u8], purpose: &str) -> Option<Value> {
    if value.len() > 8192 {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(value).ok()?;
    if bytes.len() < 28 {
        return None;
    }
    let iv: [u8; 12] = bytes[..12].try_into().ok()?;
    let mut data = bytes[28..].to_vec();
    data.extend_from_slice(&bytes[12..28]);
    let key = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, key).ok()?);
    let plain = key
        .open_in_place(
            aead::Nonce::assume_unique_for_key(iv),
            aead::Aad::from(purpose.as_bytes()),
            &mut data,
        )
        .ok()?;
    serde_json::from_slice(plain).ok()
}
fn outcome(config: &Config, name: &str, result: &str) -> Response {
    let path = "/connections";
    let mut response =
        Redirect::to(&format!("{}{path}?{name}={result}", config.dashboard)).into_response();
    response.headers_mut().append(
        "set-cookie",
        format!(
            "{}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
            cookie(name)
        )
        .parse()
        .unwrap(),
    );
    private(response)
}
async fn callback(
    State(oauth): State<OAuth>,
    Path(name): Path<String>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Response {
    let Some(config) = &oauth.config else {
        return held();
    };
    let Some(settings) = provider(config, &name) else {
        return private(StatusCode::NOT_FOUND.into_response());
    };
    let cookies: Vec<_> = headers
        .get_all("cookie")
        .iter()
        .filter_map(|h| h.to_str().ok())
        .flat_map(|s| s.split(';'))
        .filter_map(|s| s.trim().split_once('='))
        .filter(|(k, _)| *k == cookie(&name))
        .collect();
    let pending = if cookies.len() == 1 {
        unseal(cookies[0].1, &settings.key, &cookie(&name))
            .and_then(|v| serde_json::from_value::<Pending>(v).ok())
    } else {
        None
    };
    let Some(params) = query(raw) else {
        return outcome(config, &name, "invalid_state");
    };
    let Some(pending) = pending.filter(|p| {
        p.provider == name
            && p.until > now()
            && p.until <= now() + 600_000
            && uuid::Uuid::parse_str(&p.user).is_ok()
    }) else {
        return outcome(config, &name, "invalid_state");
    };
    let valid = params.get("state").is_some_and(|s| {
        s.len() == 43
            && subtle::ConstantTimeEq::ct_eq(s.as_bytes(), pending.state.as_bytes()).into()
    });
    if !valid {
        return outcome(config, &name, "invalid_state");
    }
    // Consume only after validating browser binding; a callback can exchange once.
    let active = oauth
        .tickets
        .lock()
        .unwrap()
        .remove(&format!("state:{}", pending.state));
    if !active.is_some_and(|p| p.user == pending.user && p.provider == name) {
        return outcome(config, &name, "invalid_state");
    }
    let Some(code) = params
        .get("code")
        .filter(|s| !s.is_empty() && s.len() <= 8192 && !params.contains_key("error"))
    else {
        return outcome(config, &name, "denied");
    };
    let result = exchange(config, settings, &name, &pending, code).await;
    outcome(config, &name, result.unwrap_or("failed"))
}
async fn exchange(
    config: &Config,
    settings: &Provider,
    name: &str,
    pending: &Pending,
    code: &str,
) -> Option<&'static str> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .ok()?;
    let body = token_body(config, settings, name, pending, code);
    exchange_at(
        config,
        name,
        pending,
        &client,
        body,
        if name == "google" {
            "https://oauth2.googleapis.com/token"
        } else {
            "https://www.bing.com/webmasters/oauth/token"
        },
        &format!("{}/rest/v1/rpc/complete_provider_consent", config.project),
    )
    .await
}
fn token_body(
    config: &Config,
    settings: &Provider,
    name: &str,
    pending: &Pending,
    code: &str,
) -> String {
    let mut fields = vec![
        ("client_id", settings.id.clone()),
        ("client_secret", settings.secret.clone()),
        ("grant_type", "authorization_code".into()),
        ("code", code.into()),
        (
            "redirect_uri",
            format!("{}/auth/{name}/callback", config.api),
        ),
    ];
    if name == "google" {
        fields.push(("code_verifier", pending.verifier.clone()));
    }
    form_urlencoded::Serializer::new(String::new())
        .extend_pairs(fields)
        .finish()
}
async fn exchange_at(
    config: &Config,
    name: &str,
    pending: &Pending,
    client: &reqwest::Client,
    body: String,
    token_url: &str,
    store_url: &str,
) -> Option<&'static str> {
    let settings = provider(config, name)?;
    let response = client
        .post(token_url)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > 65536 {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    let tokens: Value = serde_json::from_slice(&bytes).ok()?;
    let refresh = tokens["refresh_token"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 4096)?;
    let scopes: Vec<String> = if let Some(array) = tokens["scope"].as_array() {
        array
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    } else {
        tokens["scope"]
            .as_str()
            .unwrap_or("")
            .split([' ', ','])
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect()
    };
    if name == "google"
        && !scopes
            .iter()
            .any(|s| [ANALYTICS, SEARCH, BUSINESS].contains(&s.as_str()))
    {
        return Some("missing_scope");
    }
    if name == "bing"
        && !tokens["scope"].is_null()
        && !scopes
            .iter()
            .any(|s| s.eq_ignore_ascii_case("read") || s.eq_ignore_ascii_case("webmaster.read"))
    {
        return None;
    }
    let scopes = if name == "bing" {
        vec!["webmaster.read".to_owned()]
    } else {
        scopes
    };
    let grant = seal(
        &json!({"user":pending.user,"refresh":refresh,"scopes":scopes}),
        &settings.key,
        &format!("htp_{name}_grant:{}", pending.user),
    )
    .ok()?;
    if grant.len() > 8192 {
        return None;
    } // Legacy unseal consumers enforce this bound.
    let row = json!({"p_owner_id":pending.user,"p_provider":name,
        "p_epoch":pending.fence.epoch,"p_generation":pending.fence.generation,
        "p_encrypted_grant":grant,"p_scopes":scopes});
    let response = client
        .post(store_url)
        .header("apikey", &config.service)
        .bearer_auth(&config.service)
        .json(&row)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > 64 {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    if serde_json::from_slice::<bool>(&bytes).ok()? {
        Some("connected")
    } else {
        Some("stale_consent")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;
    fn fixture() -> OAuth {
        let p = Provider {
            id: "synthetic-client".into(),
            secret: "synthetic-secret".into(),
            key: vec![7; 32],
        };
        OAuth {
            config: Some(Arc::new(Config {
                api: "https://api.example".into(),
                dashboard: "https://dashboard.example".into(),
                project: "http://127.0.0.1:1".into(),
                service: "synthetic-service".into(),
                google: p.clone(),
                bing: p,
            })),
            ..OAuth::default()
        }
    }
    async fn online_fixture() -> OAuth {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/rest/v1/rpc/begin_provider_consent",
                    post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                        assert_eq!(headers["authorization"], "Bearer synthetic-service");
                        assert_eq!(body["p_owner_id"], uuid::Uuid::from_u128(1).to_string());
                        assert!(["google", "bing"].contains(&body["p_provider"].as_str().unwrap()));
                        Json(json!({"epoch":uuid::Uuid::from_u128(9),"generation":null}))
                    }),
                ),
            )
            .await
            .unwrap();
        });
        let mut oauth = fixture();
        Arc::make_mut(oauth.config.as_mut().unwrap()).project = base;
        oauth
    }
    fn app(oauth: &OAuth) -> Router {
        oauth
            .protected()
            .merge(oauth.public())
            .layer(Extension(AuthenticatedUser {
                id: uuid::Uuid::from_u128(1),
            }))
    }
    async fn begin(oauth: &OAuth, name: &str) -> (String, String, String) {
        let response = app(oauth)
            .oneshot(
                Request::post(format!("/providers/{name}/connect"))
                    .header("origin", "https://dashboard.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "private, no-store");
        let value: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        let url = reqwest::Url::parse(value["url"].as_str().unwrap()).unwrap();
        assert_eq!(url.origin().ascii_serialization(), "https://api.example");
        assert_eq!(url.path(), format!("/auth/{name}/start"));
        let ticket = url.query_pairs().next().unwrap().1.into_owned();
        assert_eq!(ticket.len(), 43);
        assert!(
            ticket
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        );
        let start = format!("{}?{}", url.path(), url.query().unwrap());
        let response = app(oauth)
            .oneshot(
                Request::get(&start)
                    .header("referer", "https://dashboard.example/connections")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        let cookie = response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .to_owned();
        assert!(cookie.ends_with("Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600"));
        assert!(!cookie.contains("Domain="));
        let location =
            reqwest::Url::parse(response.headers()["location"].to_str().unwrap()).unwrap();
        assert_eq!(
            location.host_str(),
            Some(if name == "google" {
                "accounts.google.com"
            } else {
                "www.bing.com"
            })
        );
        let params: HashMap<_, _> = location.query_pairs().into_owned().collect();
        assert_eq!(
            params["redirect_uri"],
            format!("https://api.example/auth/{name}/callback")
        );
        let pending: Pending = serde_json::from_value(
            unseal(
                cookie.split(';').next().unwrap().split_once('=').unwrap().1,
                &[7; 32],
                &super::cookie(name),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(pending.user, uuid::Uuid::from_u128(1).to_string());
        assert_eq!(pending.fence.epoch, uuid::Uuid::from_u128(9));
        assert!(pending.fence.generation.is_none());
        if name == "google" {
            assert_eq!(params["code_challenge_method"], "S256");
            assert_eq!(
                params["code_challenge"],
                URL_SAFE_NO_PAD.encode(Sha256::digest(pending.verifier.as_bytes()))
            );
            assert_eq!(params["scope"], format!("{ANALYTICS} {SEARCH}"));
            assert!(!params["scope"].contains(BUSINESS));
        } else {
            assert!(!params.contains_key("code_challenge"));
        }
        let replay = app(oauth)
            .oneshot(
                Request::get(&start)
                    .header("referer", "https://dashboard.example/connections")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(replay.status(), StatusCode::BAD_REQUEST);
        (
            cookie.split(';').next().unwrap().to_owned(),
            params["state"].clone(),
            start,
        )
    }
    #[tokio::test]
    async fn browser_binding_denial_and_replay_are_local() {
        for name in ["google", "bing"] {
            let oauth = online_fixture().await;
            let (cookie, state, _) = begin(&oauth, name).await;
            for (cookies, query, expected) in [
                (
                    String::new(),
                    format!("state={state}&error=denied"),
                    "invalid_state",
                ),
                (
                    format!("{cookie}; {cookie}"),
                    format!("state={state}&error=denied"),
                    "invalid_state",
                ),
                (
                    cookie.clone(),
                    "state=wrong&error=denied".into(),
                    "invalid_state",
                ),
                (
                    cookie.clone(),
                    format!("state={state}&state={state}&error=denied"),
                    "invalid_state",
                ),
                (
                    cookie.clone(),
                    format!("state={state}&error=denied"),
                    "denied",
                ),
                (
                    cookie.clone(),
                    format!("state={state}&error=denied"),
                    "invalid_state",
                ),
            ] {
                let response = app(&oauth)
                    .oneshot(
                        Request::get(format!("/auth/{name}/callback?{query}"))
                            .header("cookie", cookies)
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(
                    response.headers()["location"],
                    format!("https://dashboard.example/connections?{name}={expected}")
                );
                assert!(
                    response.headers()["set-cookie"]
                        .to_str()
                        .unwrap()
                        .contains("Max-Age=0")
                );
                assert_eq!(response.headers()["referrer-policy"], "no-referrer");
            }
        }
    }
    #[tokio::test]
    async fn connect_gate_origin_body_and_methods() {
        let held_app = app(&OAuth::default());
        for path in ["/providers/google/connect", "/providers/bing/connect"] {
            let r = held_app
                .clone()
                .oneshot(Request::post(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE);
        }
        let oauth = fixture();
        for origin in [None, Some("https://evil.example"), Some("null")] {
            let mut r = Request::post("/providers/google/connect");
            if let Some(origin) = origin {
                r = r.header("origin", origin);
            }
            assert_eq!(
                app(&oauth)
                    .oneshot(r.body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .status(),
                StatusCode::FORBIDDEN
            );
        }
        let r = app(&oauth)
            .oneshot(
                Request::post("/providers/google/connect")
                    .header("origin", "https://dashboard.example")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
        assert!(oauth.tickets.lock().unwrap().is_empty());
        let r = app(&oauth)
            .oneshot(
                Request::get("/providers/google/connect")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::METHOD_NOT_ALLOWED);
        let r = crate::app()
            .oneshot(
                Request::post("/providers/google/connect")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    }
    #[test]
    fn legacy_node_crypto_fixture_and_tamper() {
        // Produced with node:crypto createCipheriv AES-256-GCM, key [7;32], IV [3;12].
        let fixture = "AwMDAwMDAwMDAwMDoUz2IRYA3CDQnw7tfY6X1V7c1nA_Wnx4WDM6Mp8_mniEX82Aw_vxAg3ypcOGgzLdws9fGLmI3C664C5x5K3KN0JCYaH66h9bDltNzE5J-0rNuBkL1sgAeSyS3uT55Kdcjc_rKHc";
        let value = json!({"user":"synthetic-owner","refresh":"synthetic-refresh","scopes":["synthetic-scope"]});
        assert_eq!(
            unseal(fixture, &[7; 32], "htp_google_grant:synthetic-owner"),
            Some(value.clone())
        );
        assert!(unseal(fixture, &[7; 32], "htp_google_grant:other").is_none());
        assert!(unseal(fixture, &[8; 32], "htp_google_grant:synthetic-owner").is_none());
        let sealed = seal(&value, &[7; 32], "purpose").unwrap();
        assert_eq!(unseal(&sealed, &[7; 32], "purpose"), Some(value));
        let mut raw = URL_SAFE_NO_PAD.decode(sealed).unwrap();
        raw[29] ^= 1;
        assert!(unseal(&URL_SAFE_NO_PAD.encode(raw), &[7; 32], "purpose").is_none());
        assert!(origin("https://api.example/path".into()).is_none());
        assert!(origin("https://user@api.example".into()).is_none());
        assert!(origin("http://api.example".into()).is_none());
    }
    #[tokio::test]
    #[allow(clippy::too_many_lines)] // Keep the shared token/store fixture and its failure cases together.
    async fn synthetic_token_exchange_stores_legacy_grant_and_fails_without_refresh_or_scope() {
        let writes = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = writes.clone();
        let upstream=Router::new().route("/token/{case}",post(|Path(case):Path<String>, headers:HeaderMap, body:String| async move {
            assert!(!headers.contains_key("authorization"));
            assert!(body.contains("synthetic-code"));
            match case.as_str() {
                "redirect"=>(StatusCode::FOUND,Json(json!({"refresh_token":"synthetic-refresh","scope":ANALYTICS}))),
                "oversized"=>(StatusCode::OK,Json(json!({"refresh_token":"synthetic-refresh","scope":"x".repeat(70000)}))),
                "long-refresh"=>(StatusCode::OK,Json(json!({"refresh_token":"x".repeat(4097),"scope":ANALYTICS}))),
                "no-refresh"=>(StatusCode::OK,Json(json!({"scope":ANALYTICS}))),
                "no-scope"=>(StatusCode::OK,Json(json!({"refresh_token":"synthetic-refresh","scope":"unrelated"}))),
                "bing"=>(StatusCode::OK,Json(json!({"refresh_token":"synthetic-refresh","scope":"Read"}))),
                _=>(StatusCode::OK,Json(json!({"refresh_token":"synthetic-refresh","access_token":"never-persist","scope":format!("{ANALYTICS} {SEARCH}")}))),
            }
        })).route("/store",post(move |headers:HeaderMap,Json(row):Json<Value>| {let captured=captured.clone();async move {
            assert_eq!(headers["authorization"],"Bearer synthetic-service");
            assert!(!headers.contains_key("cookie"));
            captured.lock().unwrap().push(row);Json(json!(true))
        }})).route("/fail-store",post(||async{StatusCode::SERVICE_UNAVAILABLE}))
        .route("/stale-store",post(||async{Json(json!(false))}))
        .route("/malformed-store",post(||async{Json(json!({"connected":true}))}))
        .route("/empty-store",post(||async{StatusCode::NO_CONTENT}))
        .route("/large-store",post(||async{"x".repeat(65)}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let oauth = fixture();
        let config = oauth.config.as_ref().unwrap();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let pending = Pending {
            fence: ConsentFence {
                epoch: uuid::Uuid::from_u128(9),
                generation: Some(uuid::Uuid::from_u128(17)),
            },
            user: uuid::Uuid::from_u128(1).to_string(),
            provider: "google".into(),
            state: random(),
            verifier: random(),
            until: now() + 600_000,
        };
        for (name, case, expected) in [
            ("google", "ok", Some("connected")),
            ("bing", "bing", Some("connected")),
            ("google", "no-refresh", None),
            ("google", "oversized", None),
            ("google", "long-refresh", None),
            ("google", "no-scope", Some("missing_scope")),
            ("bing", "no-scope", None),
            ("google", "redirect", None),
        ] {
            let result = exchange_at(
                config,
                name,
                &pending,
                &client,
                "code=synthetic-code".into(),
                &format!("{base}/token/{case}"),
                &format!("{base}/store"),
            )
            .await;
            assert_eq!(result, expected);
        }
        assert_eq!(
            exchange_at(
                config,
                "google",
                &pending,
                &client,
                "code=synthetic-code".into(),
                &format!("{base}/token/ok"),
                &format!("{base}/fail-store")
            )
            .await,
            None
        );
        for (store, expected) in [
            ("stale-store", Some("stale_consent")),
            ("malformed-store", None),
            ("empty-store", None),
            ("large-store", None),
        ] {
            assert_eq!(
                exchange_at(
                    config,
                    "google",
                    &pending,
                    &client,
                    "code=synthetic-code".into(),
                    &format!("{base}/token/ok"),
                    &format!("{base}/{store}")
                )
                .await,
                expected
            );
        }
        let rows = writes.lock().unwrap();
        assert_eq!(rows.len(), 2);
        for (row, name) in rows.iter().zip(["google", "bing"]) {
            assert_eq!(row["p_owner_id"], pending.user);
            assert_eq!(row["p_epoch"], pending.fence.epoch.to_string());
            assert_eq!(
                row["p_generation"],
                pending.fence.generation.unwrap().to_string()
            );
            let grant = unseal(
                row["p_encrypted_grant"].as_str().unwrap(),
                &[7; 32],
                &format!("htp_{name}_grant:{}", pending.user),
            )
            .unwrap();
            assert_eq!(grant["refresh"], "synthetic-refresh");
            assert_eq!(grant["user"], pending.user);
            assert!(!row.to_string().contains("never-persist"));
        }
        server.abort();
    }
    #[tokio::test]
    async fn launch_requires_dashboard_referrer_and_expired_state_fails_closed() {
        let oauth = online_fixture().await;
        for referer in [
            None,
            Some("https://evil.example/connections"),
            Some("https://dashboard.example.evil/"),
        ] {
            let mut request = Request::get("/auth/google/start?ticket=synthetic");
            if let Some(referer) = referer {
                request = request.header("referer", referer);
            }
            let response = app(&oauth)
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
        let pending = Pending {
            fence: ConsentFence {
                epoch: uuid::Uuid::from_u128(9),
                generation: None,
            },
            user: uuid::Uuid::from_u128(1).to_string(),
            provider: "google".into(),
            state: random(),
            verifier: random(),
            until: now() - 1,
        };
        let sealed = seal(
            &serde_json::to_value(&pending).unwrap(),
            &[7; 32],
            "htp_google_state",
        )
        .unwrap();
        let response = app(&oauth)
            .oneshot(
                Request::get(format!(
                    "/auth/google/callback?state={}&code=synthetic",
                    pending.state
                ))
                .header("cookie", format!("htp_google_state={sealed}"))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.headers()["location"],
            "https://dashboard.example/connections?google=invalid_state"
        );
        let (cookie, state, _) = begin(&oauth, "google").await;
        // A restart/different process loses the single-use ledger and cannot exchange.
        let response = app(&fixture())
            .oneshot(
                Request::get(format!(
                    "/auth/google/callback?state={state}&code=synthetic"
                ))
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.headers()["location"],
            "https://dashboard.example/connections?google=invalid_state"
        );
    }
    #[tokio::test]
    async fn issuance_is_bounded_per_owner_across_providers_and_prunes_expiry() {
        let oauth = online_fixture().await;
        let _active_state = begin(&oauth, "google").await;
        let mut calls = Vec::new();
        for i in 0..32 {
            let app = app(&oauth);
            calls.push(tokio::spawn(async move {
                app.oneshot(
                    Request::post(format!(
                        "/providers/{}/connect",
                        if i % 2 == 0 { "google" } else { "bing" }
                    ))
                    .header("origin", "https://dashboard.example")
                    .body(Body::empty())
                    .unwrap(),
                )
                .await
                .unwrap()
                .status()
            }));
        }
        let mut accepted = 0;
        for call in calls {
            match call.await.unwrap() {
                StatusCode::OK => accepted += 1,
                StatusCode::SERVICE_UNAVAILABLE => {}
                status => panic!("unexpected {status}"),
            }
        }
        assert_eq!(accepted, OWNER_PENDING_LIMIT - 1);
        assert!(
            oauth
                .tickets
                .lock()
                .unwrap()
                .keys()
                .any(|key| key.starts_with("state:"))
        );
        let mut tickets = oauth.tickets.lock().unwrap();
        let mut pending = tickets.values().next().unwrap().clone();
        pending.user = uuid::Uuid::from_u128(2).to_string();
        assert!(insert_pending(
            &mut tickets,
            "other".into(),
            pending.clone()
        ));
        // Expired entries stop consuming either budget; ticket and state entries
        // both count, and the same owner cannot bypass the cap by switching provider.
        for p in tickets.values_mut() {
            p.until = now() - 1;
        }
        pending.until = now() + 600_000;
        assert!(insert_pending(
            &mut tickets,
            "fresh".into(),
            pending.clone()
        ));
        assert_eq!(tickets.len(), 1);
        for i in 1..1024 {
            pending.user = uuid::Uuid::from_u128(i + 10).to_string();
            assert!(insert_pending(
                &mut tickets,
                format!("global:{i}"),
                pending.clone()
            ));
        }
        pending.user = uuid::Uuid::from_u128(9999).to_string();
        assert!(!insert_pending(&mut tickets, "overflow".into(), pending));
    }
    #[tokio::test]
    async fn snapshot_failure_never_issues_a_ticket() {
        for value in [
            json!(false),
            json!({"epoch":"invalid","generation":null}),
            json!({"generation":null}),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                axum::serve(
                    listener,
                    Router::new().fallback(post(move || {
                        let value = value.clone();
                        async move { Json(value) }
                    })),
                )
                .await
                .unwrap();
            });
            let mut oauth = fixture();
            Arc::make_mut(oauth.config.as_mut().unwrap()).project = base;
            let r = app(&oauth)
                .oneshot(
                    Request::post("/providers/google/connect")
                        .header("origin", "https://dashboard.example")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert!(oauth.tickets.lock().unwrap().is_empty());
            server.abort();
        }
        let oauth = fixture(); // closed loopback port: no database snapshot
        assert_eq!(
            app(&oauth)
                .oneshot(
                    Request::post("/providers/bing/connect")
                        .header("origin", "https://dashboard.example")
                        .body(Body::empty())
                        .unwrap()
                )
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert!(oauth.tickets.lock().unwrap().is_empty());
    }
    #[test]
    fn exchange_form_keeps_redirect_and_google_pkce_fixed() {
        let oauth = fixture();
        let config = oauth.config.as_ref().unwrap();
        let pending = Pending {
            fence: ConsentFence {
                epoch: uuid::Uuid::from_u128(9),
                generation: None,
            },
            user: uuid::Uuid::from_u128(1).to_string(),
            provider: "google".into(),
            state: random(),
            verifier: random(),
            until: now() + 600_000,
        };
        for name in ["google", "bing"] {
            let body = token_body(
                config,
                provider(config, name).unwrap(),
                name,
                &pending,
                "synthetic-code&extra=unsafe",
            );
            let fields = query(Some(body)).unwrap();
            assert_eq!(fields["code"], "synthetic-code&extra=unsafe");
            assert!(!fields.contains_key("extra"));
            assert_eq!(fields["client_secret"], "synthetic-secret");
            assert_eq!(
                fields["redirect_uri"],
                format!("https://api.example/auth/{name}/callback")
            );
            assert_eq!(
                fields.get("code_verifier"),
                (name == "google").then_some(&pending.verifier)
            );
        }
    }
}
