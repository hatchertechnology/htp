//! Public forms ingress. Trust configuration is an operational assertion, not proxy verification.
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Path, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, net::IpAddr, sync::Arc, time::Duration};
use subtle::ConstantTimeEq;

#[derive(Clone)]
enum IdentityMode {
    Disabled,
    Fly,
    Edge(Vec<[u8; 32]>),
}

// Keys are uniformly random 32-byte values encoded as exactly 64 lowercase hex digits.
fn edge_key(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let mut key = [0; 32];
    for (i, byte) in key.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(key)
}

fn identity_mode(
    mode: Option<&str>,
    fly: bool,
    current: Option<&str>,
    previous: Option<&str>,
) -> IdentityMode {
    match mode {
        None | Some("fly") if fly => IdentityMode::Fly,
        Some("edge") => {
            let Some(key) = current.and_then(edge_key) else {
                return IdentityMode::Disabled;
            };
            let mut keys = vec![key];
            if let Some(previous) = previous {
                let Some(key) = edge_key(previous) else {
                    return IdentityMode::Disabled;
                };
                keys.push(key);
            }
            IdentityMode::Edge(keys)
        }
        _ => IdentityMode::Disabled,
    }
}

#[derive(Clone)]
struct Config {
    client: reqwest::Client,
    db: String,
    service_key: String,
    hash_key: String,
    identity: IdentityMode,
    slots: Arc<tokio::sync::Semaphore>,
    #[cfg(test)]
    allow_test_loopback: bool,
}
impl Config {
    fn from_env() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(12))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("HTTP client"),
            db: std::env::var("SUPABASE_URL").unwrap_or_default(),
            service_key: std::env::var("FORMS_SERVICE_KEY").unwrap_or_default(),
            hash_key: std::env::var("FORMS_IP_HASH_KEY").unwrap_or_default(),
            identity: identity_mode(
                std::env::var_os("FORMS_INGRESS_MODE")
                    .as_ref()
                    .map(|v| v.to_str().unwrap_or("invalid")),
                std::env::var("FORMS_TRUST_FLY_PROXY").as_deref() == Ok("verified"),
                std::env::var("FORMS_EDGE_KEY_CURRENT").ok().as_deref(),
                std::env::var_os("FORMS_EDGE_KEY_PREVIOUS")
                    .as_ref()
                    .map(|v| v.to_str().unwrap_or("invalid")),
            ),
            slots: Arc::new(tokio::sync::Semaphore::new(32)),
            #[cfg(test)]
            allow_test_loopback: false,
        }
    }
    fn ready(&self) -> bool {
        !matches!(self.identity, IdentityMode::Disabled)
            && self.hash_key.len() >= 32
            && !self.service_key.is_empty()
            && reqwest::Url::parse(&self.db).is_ok_and(|u| {
                let secure = u.scheme() == "https";
                #[cfg(test)]
                let secure = secure
                    || (self.allow_test_loopback
                        && u.scheme() == "http"
                        && u.host_str() == Some("127.0.0.1"));
                secure
                    && u.host_str().is_some()
                    && u.username().is_empty()
                    && u.password().is_none()
                    && u.query().is_none()
                    && u.fragment().is_none()
            })
    }
    async fn rpc(&self, name: &str, args: Value) -> Result<Value, ()> {
        let response = self
            .client
            .post(format!(
                "{}/rest/v1/rpc/{name}",
                self.db.trim_end_matches('/')
            ))
            .header("apikey", &self.service_key)
            .bearer_auth(&self.service_key)
            .json(&args)
            .send()
            .await
            .map_err(|_| ())?;
        if !response.status().is_success() {
            return Err(());
        }
        let mut stream = response.bytes_stream();
        let mut body = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| ())?;
            if body.len() + chunk.len() > 32_768 {
                return Err(());
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body).map_err(|_| ())
    }
}
pub fn router() -> Router {
    Router::new()
        .route("/public/forms/{form_id}", any(submit))
        .with_state(Config::from_env())
        .layer(axum::middleware::from_fn_with_state(
            std::env::var("HTP_ROLLOUT_FORMS").as_deref() == Ok("true"),
            forms_gate,
        ))
}
async fn forms_gate(
    State(enabled): State<bool>,
    request: Request,
    next: axum::middleware::Next,
) -> Response {
    if !enabled {
        return respond(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error":"temporarily_unavailable"}),
            None,
            false,
        );
    }
    next.run(request).await
}
fn respond(status: StatusCode, value: Value, origin: Option<&str>, retry: bool) -> Response {
    let mut response = (status, axum::Json(value)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Origin"));
    if let Some(origin) = origin.and_then(|s| HeaderValue::from_str(s).ok()) {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    if retry {
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("600"));
        if origin.is_some() {
            response.headers_mut().insert(
                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                HeaderValue::from_static("Retry-After"),
            );
        }
    }
    response
}
fn error(status: StatusCode, code: &'static str, origin: Option<&str>) -> Response {
    respond(
        status,
        json!({"error":code}),
        origin,
        status == StatusCode::TOO_MANY_REQUESTS,
    )
}
fn client_ip(mode: &IdentityMode, h: &HeaderMap) -> Option<IpAddr> {
    let name = match mode {
        IdentityMode::Disabled => return None,
        IdentityMode::Fly => "fly-client-ip",
        IdentityMode::Edge(keys) => {
            let mut auth = h.get_all("x-htp-edge-auth").iter();
            let candidate = edge_key(auth.next()?.to_str().ok()?)?;
            if auth.next().is_some() {
                return None;
            }
            let mut valid = subtle::Choice::from(0);
            for key in keys {
                valid |= key.ct_eq(&candidate);
            }
            if !bool::from(valid) {
                return None;
            }
            "x-htp-client-ip"
        }
    };
    let mut values = h.get_all(name).iter();
    let first = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        return None;
    }
    first.parse().ok()
}
fn canonical_uuid(s: &str) -> bool {
    s.len() == 36
        && uuid::Uuid::parse_str(s)
            .is_ok_and(|u| u.hyphenated().to_string() == s.to_ascii_lowercase())
}
fn browser_origin(headers: &HeaderMap) -> Option<(String, String)> {
    if headers.get_all(header::ORIGIN).iter().count() > 1
        || headers.get_all(header::REFERER).iter().count() > 1
    {
        return None;
    }
    let origin = headers.get(header::ORIGIN);
    let raw = origin
        .or_else(|| headers.get(header::REFERER))?
        .to_str()
        .ok()?;
    if raw == "null" {
        return None;
    }
    let url = reqwest::Url::parse(raw).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.host_str().is_none()
        || (origin.is_some()
            && (url.path() != "/" || url.query().is_some() || url.fragment().is_some()))
    {
        return None;
    }
    Some((
        url.origin().ascii_serialization(),
        url.host_str()?.to_owned(),
    ))
}
const REQUEST_DEADLINE: Duration = Duration::from_secs(25);
async fn submit(State(c): State<Config>, Path(id): Path<String>, request: Request) -> Response {
    submit_with_deadline(c, id, request, REQUEST_DEADLINE).await
}
async fn submit_with_deadline(
    c: Config,
    id: String,
    request: Request,
    deadline: Duration,
) -> Response {
    match tokio::time::timeout(deadline, submit_inner(c, id, request)).await {
        Ok(response) => response,
        // A cancelled HTTP request does not prove the database rolled back.
        Err(_) => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "temporarily_unavailable",
            None,
        ),
    }
}
async fn submit_inner(c: Config, id: String, request: Request) -> Response {
    if !c.ready() {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "temporarily_unavailable",
            None,
        );
    }
    let Ok(_permit) = c.slots.try_acquire() else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "temporarily_unavailable",
            None,
        );
    };
    let Some(ip) = client_ip(&c.identity, request.headers()) else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "temporarily_unavailable",
            None,
        );
    };
    let digest = format!(
        "{:x}",
        Sha256::digest(format!("{}\0{ip}", c.hash_key).as_bytes())
    );
    match c.rpc("charge_form_client", json!({"p_hash":digest})).await {
        Ok(Value::String(s)) if s == "ok" => (),
        Ok(Value::String(s)) if s == "rate_limited" => {
            return error(StatusCode::TOO_MANY_REQUESTS, "rate_limited", None);
        }
        _ => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "temporarily_unavailable",
                None,
            );
        }
    }
    if !canonical_uuid(&id) {
        return error(StatusCode::NOT_FOUND, "form_unavailable", None);
    }
    let form_limited = match c.rpc("charge_form_ingress", json!({"p_form_id":id})).await {
        Ok(Value::String(s)) if s == "ok" => false,
        Ok(Value::String(s)) if s == "rate_limited" => true,
        Ok(Value::String(s)) if s == "unavailable" => {
            return error(StatusCode::NOT_FOUND, "form_unavailable", None);
        }
        _ => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "temporarily_unavailable",
                None,
            );
        }
    };
    let Some((origin, host)) = browser_origin(request.headers()) else {
        return error(StatusCode::FORBIDDEN, "origin_required", None);
    };
    match c
        .rpc(
            "website_form_origin_allowed",
            json!({"p_form_id":id,"p_host":host}),
        )
        .await
    {
        Ok(Value::Bool(true)) => (),
        Ok(Value::Bool(false)) => return error(StatusCode::NOT_FOUND, "form_unavailable", None),
        _ => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "temporarily_unavailable",
                None,
            );
        }
    }
    if request.method() == Method::OPTIONS {
        let mut r = Response::new(Body::empty());
        *r.status_mut() = StatusCode::NO_CONTENT;
        let h = r.headers_mut();
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        h.insert(header::VARY, HeaderValue::from_static("Origin"));
        if let Ok(v) = HeaderValue::from_str(&origin) {
            h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
        }
        h.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("POST, OPTIONS"),
        );
        h.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("Content-Type, Accept"),
        );
        return r;
    }
    if form_limited {
        return error(StatusCode::TOO_MANY_REQUESTS, "rate_limited", Some(&origin));
    }
    if request.method() != Method::POST {
        return error(
            StatusCode::METHOD_NOT_ALLOWED,
            "method_not_allowed",
            Some(&origin),
        );
    }
    let typ = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(';').next())
        .unwrap_or("")
        .to_ascii_lowercase();
    let Ok(Ok(body)) = tokio::time::timeout(
        Duration::from_secs(10),
        to_bytes(request.into_body(), 20_000),
    )
    .await
    else {
        return error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "request_too_large",
            Some(&origin),
        );
    };
    let Ok(text) = std::str::from_utf8(&body) else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", Some(&origin));
    };
    let mut input = if typ == "application/json" {
        match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(v)) => v,
            _ => return error(StatusCode::BAD_REQUEST, "invalid_request", Some(&origin)),
        }
    } else if typ == "application/x-www-form-urlencoded" {
        let mut values = serde_json::Map::new();
        let mut seen = HashSet::new();
        for (key, val) in form_urlencoded::parse(text.as_bytes()) {
            if !seen.insert(key.to_string()) {
                return error(StatusCode::BAD_REQUEST, "invalid_request", Some(&origin));
            }
            values.insert(key.to_string(), Value::String(val.to_string()));
        }
        values
    } else {
        return error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_content_type",
            Some(&origin),
        );
    };
    let submission = input.remove("submission_id").unwrap_or_else(|| {
        if typ == "application/x-www-form-urlencoded" {
            Value::String(uuid::Uuid::new_v4().to_string())
        } else {
            Value::Null
        }
    });
    let Some(submission) = submission.as_str().filter(|s| canonical_uuid(s)) else {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_submission_id",
            Some(&origin),
        );
    };
    if input
        .remove("website")
        .is_some_and(|v| v != Value::String(String::new()))
    {
        return error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "spam_rejected",
            Some(&origin),
        );
    }
    let result = c
        .rpc(
            "accept_website_form",
            json!({"p_form_id":id,"p_submission_id":submission,"p_host":host,"p_values":input}),
        )
        .await;
    match result {
        Ok(v)
            if v.get("ok") == Some(&Value::Bool(true))
                && v.get("duplicate").and_then(Value::as_bool).is_some() =>
        {
            respond(StatusCode::OK, v, Some(&origin), false)
        }
        Ok(v) => match v.get("error").and_then(Value::as_str) {
            Some("form_unavailable") => {
                error(StatusCode::NOT_FOUND, "form_unavailable", Some(&origin))
            }
            Some("invalid_request") => {
                error(StatusCode::BAD_REQUEST, "invalid_request", Some(&origin))
            }
            Some("validation_failed") if v.get("fields").is_some_and(Value::is_object) => {
                respond(StatusCode::UNPROCESSABLE_ENTITY, v, Some(&origin), false)
            }
            Some("idempotency_conflict") => {
                error(StatusCode::CONFLICT, "idempotency_conflict", Some(&origin))
            }
            Some("rate_limited") => {
                error(StatusCode::TOO_MANY_REQUESTS, "rate_limited", Some(&origin))
            }
            _ => error(
                StatusCode::SERVICE_UNAVAILABLE,
                "temporarily_unavailable",
                Some(&origin),
            ),
        },
        Err(()) => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "temporarily_unavailable",
            Some(&origin),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;
    #[tokio::test]
    async fn rollout_gate_is_closed_by_default_and_does_not_bypass_readiness() {
        for enabled in [false, true] {
            let app = Router::new()
                .route("/public/forms/{form_id}", any(submit))
                .with_state(Config::from_env())
                .layer(axum::middleware::from_fn_with_state(enabled, forms_gate));
            let response = app.oneshot(request(Method::POST, "{}")).await.unwrap();
            // Even with the rollout enabled, absent trusted ingress configuration fails closed.
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        }
    }
    const ID: &str = "00000000-0000-0000-0000-000000000003";
    const SID: &str = "00000000-0000-0000-0000-000000000005";
    fn request(method: Method, body: &str) -> Request {
        Request::builder()
            .method(method)
            .uri(format!("/public/forms/{ID}"))
            .header("fly-client-ip", "192.0.2.1")
            .header(header::ORIGIN, "https://www.example.com")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_owned()))
            .unwrap()
    }
    async fn value(r: Response) -> Value {
        serde_json::from_slice(&to_bytes(r.into_body(), 32768).await.unwrap()).unwrap()
    }
    fn configured(base: String) -> Config {
        let mut c = Config::from_env();
        c.identity = IdentityMode::Fly;
        c.allow_test_loopback = true;
        c.db = base;
        c.hash_key = "h".repeat(48);
        c.service_key = "fixture".into();
        c
    }
    #[test]
    fn exact_browser_origin_and_proxy_identity() {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", HeaderValue::from_static("1.2.3.4"));
        assert!(client_ip(&IdentityMode::Fly, &h).is_none());
        h.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://www.example.com"),
        );
        assert_eq!(browser_origin(&h).unwrap().1, "www.example.com");
        for bad in [
            "http://www.example.com",
            "https://www.example.com:444",
            "https://evil@www.example.com",
            "https://www.example.com/path",
            "null",
        ] {
            h.insert(header::ORIGIN, HeaderValue::from_str(bad).unwrap());
            assert!(browser_origin(&h).is_none());
        }
    }
    #[test]
    fn edge_identity_is_independent_and_fails_closed() {
        let current = "ab".repeat(32);
        let previous = "cd".repeat(32);
        let mode = identity_mode(Some("edge"), true, Some(&current), Some(&previous));
        let mut headers = HeaderMap::new();
        headers.insert("fly-client-ip", HeaderValue::from_static("192.0.2.4"));
        assert!(client_ip(&mode, &headers).is_none());
        headers.insert("x-htp-client-ip", HeaderValue::from_static("192.0.2.5"));
        for key in [&current, &previous] {
            headers.insert("x-htp-edge-auth", HeaderValue::from_str(key).unwrap());
            assert_eq!(
                client_ip(&mode, &headers),
                Some("192.0.2.5".parse().unwrap())
            );
        }
        headers.insert(
            "x-htp-edge-auth",
            HeaderValue::from_str(&"ef".repeat(32)).unwrap(),
        );
        assert!(client_ip(&mode, &headers).is_none());
        headers.insert("x-htp-edge-auth", HeaderValue::from_str(&current).unwrap());
        headers.append("x-htp-edge-auth", HeaderValue::from_str(&current).unwrap());
        assert!(client_ip(&mode, &headers).is_none());
        headers.remove("x-htp-edge-auth");
        headers.insert("x-htp-edge-auth", HeaderValue::from_str(&current).unwrap());
        headers.append("x-htp-client-ip", HeaderValue::from_static("192.0.2.6"));
        assert!(client_ip(&mode, &headers).is_none());
        assert!(matches!(
            identity_mode(Some("edge"), true, None, None),
            IdentityMode::Disabled
        ));
        assert!(matches!(
            identity_mode(Some("edge"), true, Some(&current), Some("bad")),
            IdentityMode::Disabled
        ));
        assert!(matches!(
            identity_mode(Some("unknown"), true, None, None),
            IdentityMode::Disabled
        ));
        assert!(matches!(
            identity_mode(None, false, None, None),
            IdentityMode::Disabled
        ));
        assert!(matches!(
            identity_mode(None, true, None, None),
            IdentityMode::Fly
        ));
    }

    #[tokio::test]
    async fn rpc_path_preserves_limits_and_submission_contract() {
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count2 = count.clone();
        let fake = Router::new().route(
            "/rest/v1/rpc/{name}",
            axum::routing::post(
                move |Path(name): Path<String>, axum::Json(args): axum::Json<Value>| {
                    let count = count2.clone();
                    async move {
                        match name.as_str() {
                            "charge_form_client" | "charge_form_ingress" => axum::Json(json!("ok")),
                            "website_form_origin_allowed" => {
                                axum::Json(json!(args["p_host"] == "www.example.com"))
                            }
                            "accept_website_form" => {
                                if args["p_values"]["name"] == "Ada #1" {
                                    assert!(canonical_uuid(
                                        args["p_submission_id"].as_str().unwrap()
                                    ));
                                }
                                let n = count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                                axum::Json(json!({"ok":true,"duplicate":n>0}))
                            }
                            _ => axum::Json(Value::Null),
                        }
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, fake).await.unwrap() });
        let app = Router::new()
            .route("/public/forms/{form_id}", any(submit))
            .with_state(configured(base));
        let pre = app
            .clone()
            .oneshot(request(Method::OPTIONS, ""))
            .await
            .unwrap();
        assert_eq!(pre.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            pre.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "https://www.example.com"
        );
        let payload =
            json!({"submission_id":SID,"name":"Ada","email":"ada@example.com"}).to_string();
        let first = app
            .clone()
            .oneshot(request(Method::POST, &payload))
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(value(first).await["duplicate"], false);
        let retry = app
            .clone()
            .oneshot(request(Method::POST, &payload))
            .await
            .unwrap();
        assert_eq!(value(retry).await["duplicate"], true);
        let html = Request::builder()
            .method(Method::POST)
            .uri(format!("/public/forms/{ID}"))
            .header("fly-client-ip", "192.0.2.1")
            .header(header::ORIGIN, "https://www.example.com")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from("name=Ada+%231&email=ada%40example.com"))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(html).await.unwrap().status(),
            StatusCode::OK
        );
        let duplicate = Request::builder()
            .method(Method::POST)
            .uri(format!("/public/forms/{ID}"))
            .header("fly-client-ip", "192.0.2.1")
            .header(header::ORIGIN, "https://www.example.com")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from("name=A&name=B"))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(duplicate).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
        let spam = app
            .clone()
            .oneshot(request(
                Method::POST,
                &json!({"submission_id":SID,"website":"bot"}).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(spam.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 3);
        let bad = app
            .clone()
            .oneshot(request(Method::POST, &"x".repeat(20_001)))
            .await
            .unwrap();
        assert_eq!(bad.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let mut missing = Config::from_env();
        missing.identity = IdentityMode::Disabled;
        let app = Router::new()
            .route("/public/forms/{form_id}", any(submit))
            .with_state(missing);
        assert_eq!(
            app.oneshot(request(Method::POST, &payload))
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        server.abort();
    }
    // A cooperative test double: copies only public contract headers, then supplies
    // identity obtained from its synthetic transport and its own secret.
    fn synthetic_forward(incoming: Request, ip: &str, key: &str) -> Request {
        let (parts, body) = incoming.into_parts();
        let mut builder = Request::builder().method(parts.method).uri(parts.uri);
        for name in [
            header::ORIGIN,
            header::REFERER,
            header::CONTENT_TYPE,
            header::ACCEPT,
        ] {
            for value in parts.headers.get_all(&name) {
                builder = builder.header(&name, value);
            }
        }
        builder
            .header("x-htp-client-ip", ip)
            .header("x-htp-edge-auth", key)
            .body(body)
            .unwrap()
    }

    #[tokio::test]
    async fn synthetic_forwarder_preserves_admission_cors_and_receipts() {
        let key = "ab".repeat(32);
        let expected = format!(
            "{:x}",
            Sha256::digest(format!("{}\0{}", "h".repeat(48), "192.0.2.9").as_bytes())
        );
        let accepted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = accepted.clone();
        let fake = Router::new().route("/rest/v1/rpc/{name}", axum::routing::post(move |Path(name): Path<String>, axum::Json(args): axum::Json<Value>| {
            let counter = counter.clone(); let expected = expected.clone(); async move {
                axum::Json(match name.as_str() {
                    "charge_form_client" => { assert_eq!(args["p_hash"], expected); json!("ok") },
                    "charge_form_ingress" => json!("ok"),
                    "website_form_origin_allowed" => json!(true),
                    "accept_website_form" => json!({"ok":true,"duplicate":counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst)>0}),
                    _ => Value::Null,
                })
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut config = configured(format!("http://{}", listener.local_addr().unwrap()));
        config.identity = identity_mode(Some("edge"), true, Some(&key), None);
        let server = tokio::spawn(async move { axum::serve(listener, fake).await.unwrap() });
        let app = Router::new()
            .route("/public/forms/{form_id}", any(submit))
            .with_state(config);
        let mut incoming = request(Method::OPTIONS, "");
        incoming
            .headers_mut()
            .insert("x-htp-client-ip", HeaderValue::from_static("198.51.100.1"));
        incoming
            .headers_mut()
            .insert("x-htp-edge-auth", HeaderValue::from_static("untrusted"));
        let pre = app
            .clone()
            .oneshot(synthetic_forward(incoming, "192.0.2.9", &key))
            .await
            .unwrap();
        assert_eq!(pre.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            pre.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "https://www.example.com"
        );
        let payload = json!({"submission_id":SID,"name":"Ada"}).to_string();
        for duplicate in [false, true] {
            let response = app
                .clone()
                .oneshot(synthetic_forward(
                    request(Method::POST, &payload),
                    "192.0.2.9",
                    &key,
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(value(response).await["duplicate"], duplicate);
        }
        assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 2);
        server.abort();
    }

    #[tokio::test]
    async fn limited_form_preflight_then_readable_post_and_database_failure() {
        let fake = Router::new().route(
            "/rest/v1/rpc/{name}",
            axum::routing::post(|Path(name): Path<String>| async move {
                axum::Json(match name.as_str() {
                    "charge_form_client" => json!("ok"),
                    "charge_form_ingress" => json!("rate_limited"),
                    "website_form_origin_allowed" => json!(true),
                    _ => Value::Null,
                })
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, fake).await.unwrap() });
        let c = configured(base);
        let app = Router::new()
            .route("/public/forms/{form_id}", any(submit))
            .with_state(c.clone());
        assert_eq!(
            app.clone()
                .oneshot(request(Method::OPTIONS, ""))
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        let limited = app.oneshot(request(Method::POST, "{}")).await.unwrap();
        assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(limited.headers()[header::RETRY_AFTER], "600");
        assert_eq!(
            limited.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "https://www.example.com"
        );
        server.abort();
        let mut broken = c;
        broken.db = "http://127.0.0.1:1".into();
        let app = Router::new()
            .route("/public/forms/{form_id}", any(submit))
            .with_state(broken);
        let failed = app.oneshot(request(Method::POST, "{}")).await.unwrap();
        assert_eq!(failed.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(
            failed
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .is_none()
        );
    }
    #[tokio::test]
    async fn aggregate_deadline_releases_slot_and_retry_preserves_uncertain_write() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let stored = calls.clone();
        let fake = Router::new().route(
            "/rest/v1/rpc/{name}",
            axum::routing::post(
                move |Path(name): Path<String>, axum::Json(args): axum::Json<Value>| {
                    let stored = stored.clone();
                    async move {
                        match name.as_str() {
                            "charge_form_client" | "charge_form_ingress" => axum::Json(json!("ok")),
                            "website_form_origin_allowed" => axum::Json(json!(true)),
                            "accept_website_form" => {
                                assert_eq!(args["p_submission_id"], SID);
                                assert_eq!(args["p_values"]["name"], "Ada");
                                let n = stored.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                                if n == 0 {
                                    tokio::time::sleep(Duration::from_secs(3)).await;
                                }
                                axum::Json(json!({"ok":true,"duplicate":n>0}))
                            }
                            _ => axum::Json(Value::Null),
                        }
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, fake).await.unwrap() });
        let mut c = configured(base);
        c.slots = Arc::new(tokio::sync::Semaphore::new(1));
        let payload =
            json!({"submission_id":SID,"name":"Ada","email":"ada@example.com"}).to_string();
        let timed = submit_with_deadline(
            c.clone(),
            ID.into(),
            request(Method::POST, &payload),
            Duration::from_millis(500),
        )
        .await;
        assert_eq!(timed.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(
            timed
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .is_none()
        );
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(c.slots.available_permits(), 1);
        let retry = submit_with_deadline(
            c,
            ID.into(),
            request(Method::POST, &payload),
            Duration::from_secs(2),
        )
        .await;
        assert_eq!(retry.status(), StatusCode::OK);
        assert_eq!(value(retry).await["duplicate"], true);
        server.abort();
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires Node, OpenSSL, and installed Playwright Chromium"]
    async fn browser_cors_against_actual_api() {
        let accepted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let accepted_rpc = accepted.clone();
        let early = format!(
            "{:x}",
            Sha256::digest(format!("{}\0{}", "h".repeat(48), "192.0.2.2").as_bytes())
        );
        let fake=Router::new().route("/rest/v1/rpc/{name}",axum::routing::post(move |Path(name):Path<String>, axum::Json(args):axum::Json<Value>| {
            let accepted=accepted_rpc.clone(); let early=early.clone(); async move {
                axum::Json(match name.as_str() {
                    "charge_form_client" if args["p_hash"] == early => json!("rate_limited"),
                    "charge_form_client" => json!("ok"),
                    "charge_form_ingress" if args["p_form_id"] == ID => json!("rate_limited"),
                    "charge_form_ingress" => json!("ok"),
                    "website_form_origin_allowed" => json!(args["p_host"] == "visitor.test"),
                    "accept_website_form" => json!({"ok":true,"duplicate":accepted.fetch_add(1,std::sync::atomic::Ordering::SeqCst)>0}),
                    _=>Value::Null,
                })
            }
        }));
        let rpc_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let db = format!("http://{}", rpc_listener.local_addr().unwrap());
        let rpc_server =
            tokio::spawn(async move { axum::serve(rpc_listener, fake).await.unwrap() });
        let app = Router::new()
            .route("/public/forms/{form_id}", any(submit))
            .with_state(configured(db));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let api_server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let web = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../web");
        let result = tokio::task::spawn_blocking(move || {
            std::process::Command::new("node")
                .current_dir(web)
                .env("FORMS_BROWSER_API_PORT", port.to_string())
                .arg("tests/fixtures/check-forms-api-cors.mjs")
                .status()
        })
        .await
        .unwrap()
        .expect("run browser fixture");
        api_server.abort();
        rpc_server.abort();
        assert!(result.success(), "browser fixture failed");
        assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 2);
    }
    #[tokio::test]
    #[ignore = "requires disposable PostgREST and PostgreSQL fixture"]
    async fn disposable_postgrest_acceptance_and_retry() {
        let base = std::env::var("FORMS_TEST_DB").expect("disposable database gateway");
        let key = std::env::var("FORMS_TEST_SERVICE_JWT").expect("disposable service JWT");
        let mut c = configured(base);
        c.service_key = key;
        let app = Router::new()
            .route("/public/forms/{form_id}", any(submit))
            .with_state(c);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!(
            "http://{}/public/forms/{ID}",
            listener.local_addr().unwrap()
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let pre = client
            .request(Method::OPTIONS, &endpoint)
            .header("fly-client-ip", "192.0.2.1")
            .header(header::ORIGIN, "https://www.example.com")
            .send()
            .await
            .unwrap();
        assert_eq!(pre.status(), StatusCode::NO_CONTENT);
        let payload = json!({"submission_id":SID,"name":"Ada","email":"ada@example.com"});
        for expected in [false, true] {
            let response = client
                .post(&endpoint)
                .header("fly-client-ip", "192.0.2.1")
                .header(header::ORIGIN, "https://www.example.com")
                .json(&payload)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.json::<Value>().await.unwrap()["duplicate"],
                expected
            );
        }
        let changed = json!({"submission_id":SID,"name":"Eve","email":"ada@example.com"});
        let conflict = client
            .post(&endpoint)
            .header("fly-client-ip", "192.0.2.1")
            .header(header::ORIGIN, "https://www.example.com")
            .json(&changed)
            .send()
            .await
            .unwrap();
        assert_eq!(conflict.status(), StatusCode::CONFLICT);
        let bad=client.post(&endpoint).header("fly-client-ip","192.0.2.1").header(header::ORIGIN,"https://www.example.com").json(&json!({"submission_id":"00000000-0000-0000-0000-000000000006","name":"Ada","email":"bad"})).send().await.unwrap();
        assert_eq!(bad.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let denied = client
            .request(Method::OPTIONS, &endpoint)
            .header("fly-client-ip", "192.0.2.1")
            .header(header::ORIGIN, "https://evil.example.com")
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::NOT_FOUND);
        assert!(
            denied
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .is_none()
        );
        let unauth=client.post(format!("{}/rest/v1/rpc/accept_website_form",std::env::var("FORMS_TEST_DB").unwrap())).json(&json!({"p_form_id":ID,"p_submission_id":SID,"p_host":"www.example.com","p_values":{}})).send().await.unwrap();
        assert!(!unauth.status().is_success());
        server.abort();
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires disposable pilot-scoped PostgREST, Node and Chromium"]
    async fn disposable_pilot_postgrest_browser_cors() {
        let base = std::env::var("FORMS_TEST_DB").expect("disposable database gateway");
        let key = std::env::var("FORMS_TEST_SERVICE_JWT").expect("disposable service JWT");
        let fixture_url = reqwest::Url::parse(&base).expect("valid fixture URL");
        assert!(
            fixture_url.scheme() == "http"
                && fixture_url.host_str() == Some("127.0.0.1")
                && fixture_url.port().is_some_and(|port| port >= 1024)
                && fixture_url.path() == "/"
                && fixture_url.query().is_none()
                && fixture_url.fragment().is_none()
                && fixture_url.username().is_empty()
                && fixture_url.password().is_none(),
            "disposable loopback PostgREST URL required"
        );
        // Bare PostgREST exposes /rpc; hosted Supabase prefixes /rest/v1.
        let gateway = Router::new().route(
            "/rest/v1/rpc/{name}",
            axum::routing::post(
                move |Path(name): Path<String>, mut headers: HeaderMap, body: axum::Json<Value>| {
                    let base = base.clone();
                    async move {
                        headers.remove(header::HOST);
                        headers.remove(header::CONTENT_LENGTH);
                        let response = reqwest::Client::new()
                            .post(format!("{}/rpc/{name}", base.trim_end_matches('/')))
                            .headers(headers)
                            .json(&body.0)
                            .send()
                            .await
                            .unwrap();
                        let status = response.status();
                        (status, response.bytes().await.unwrap())
                    }
                },
            ),
        );
        let gateway_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gateway_url = format!("http://{}", gateway_listener.local_addr().unwrap());
        let gateway_server =
            tokio::spawn(async move { axum::serve(gateway_listener, gateway).await.unwrap() });
        let mut config = configured(gateway_url);
        config.service_key = key;
        let app = Router::new()
            .route("/public/forms/{form_id}", any(submit))
            .with_state(config);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let web = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../web");
        let result = tokio::task::spawn_blocking(move || {
            std::process::Command::new("node")
                .current_dir(web)
                .env("FORMS_BROWSER_API_PORT", port.to_string())
                .arg("tests/fixtures/check-forms-pilot-api-cors.mjs")
                .status()
        })
        .await
        .unwrap()
        .expect("run pilot browser fixture");
        server.abort();
        gateway_server.abort();
        assert!(result.success(), "pilot browser fixture failed");
    }
}
