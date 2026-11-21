//! Fail-closed public ingress. Fly identity mode must only be enabled after
//! integration verifies the proxy is the exclusive path to this listener.
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Path, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use sha2::{Digest, Sha256};
use std::{net::IpAddr, sync::Arc, time::Duration};

#[derive(Clone)]
struct Config {
    client: reqwest::Client,
    receiver: String,
    db: String,
    service_key: String,
    secret: String,
    hash_key: String,
    trusted_fly: bool,
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
            receiver: std::env::var("FORMS_RECEIVER_URL").unwrap_or_default(),
            db: std::env::var("SUPABASE_URL").unwrap_or_default(),
            service_key: std::env::var("FORMS_SERVICE_KEY").unwrap_or_default(),
            secret: std::env::var("FORMS_INGRESS_SECRET").unwrap_or_default(),
            hash_key: std::env::var("FORMS_IP_HASH_KEY").unwrap_or_default(),
            trusted_fly: std::env::var("FORMS_TRUST_FLY_PROXY").as_deref() == Ok("verified"),
            slots: Arc::new(tokio::sync::Semaphore::new(32)),
            #[cfg(test)]
            allow_test_loopback: false,
        }
    }
    fn test_loopback(&self, url: &reqwest::Url) -> bool {
        #[cfg(test)]
        {
            return self.allow_test_loopback
                && url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1");
        }
        #[cfg(not(test))]
        {
            let _ = url;
            false
        }
    }
    fn ready(&self) -> bool {
        self.trusted_fly
            && (32..=256).contains(&self.secret.len())
            && self.hash_key.len() >= 32
            && !self.service_key.is_empty()
            && [self.receiver.as_str(), self.db.as_str()].iter().all(|u| {
                reqwest::Url::parse(u).is_ok_and(|x| {
                    (x.scheme() == "https" || self.test_loopback(&x))
                        && x.host_str().is_some()
                        && x.username().is_empty()
                        && x.password().is_none()
                        && x.query().is_none()
                        && x.fragment().is_none()
                })
            })
    }
}
pub fn router() -> Router {
    Router::new()
        .route("/public/forms/{form_id}", any(forward))
        .with_state(Config::from_env())
}
fn error(status: StatusCode, code: &'static str) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        axum::Json(serde_json::json!({"error":code})),
    )
        .into_response()
}
fn client_ip(headers: &HeaderMap) -> Option<IpAddr> {
    let mut values = headers.get_all("fly-client-ip").iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        return None;
    }
    value.parse().ok()
}
async fn forward(State(c): State<Config>, Path(id): Path<String>, request: Request) -> Response {
    if !c.ready() {
        return error(StatusCode::SERVICE_UNAVAILABLE, "temporarily_unavailable");
    }
    let Ok(_permit) = c.slots.try_acquire() else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "temporarily_unavailable");
    };
    let Some(ip) = client_ip(request.headers()) else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "temporarily_unavailable");
    };
    // A secret prefix and separator make the stored digest unlinkable without the key.
    let digest = format!(
        "{:x}",
        Sha256::digest(format!("{}\0{ip}", c.hash_key).as_bytes())
    );
    let admission = c
        .client
        .post(format!(
            "{}/rest/v1/rpc/charge_form_client",
            c.db.trim_end_matches('/')
        ))
        .header("apikey", &c.service_key)
        .bearer_auth(&c.service_key)
        .json(&serde_json::json!({"p_hash":digest}))
        .send()
        .await;
    let Ok(admission) = admission else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "temporarily_unavailable");
    };
    if !admission.status().is_success() {
        return error(StatusCode::SERVICE_UNAVAILABLE, "temporarily_unavailable");
    }
    use futures_util::StreamExt;
    let mut admission_stream = admission.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = admission_stream.next().await {
        let Ok(chunk) = chunk else {
            return error(StatusCode::SERVICE_UNAVAILABLE, "temporarily_unavailable");
        };
        if bytes.len() + chunk.len() > 256 {
            return error(StatusCode::SERVICE_UNAVAILABLE, "temporarily_unavailable");
        }
        bytes.extend_from_slice(&chunk);
    }
    let Ok(result) = serde_json::from_slice::<String>(&bytes) else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "temporarily_unavailable");
    };
    if result == "rate_limited" {
        let mut r = error(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
        r.headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("600"));
        if let Some(origin) = request.headers().get(header::ORIGIN) {
            r.headers_mut()
                .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
            r.headers_mut().insert(
                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                HeaderValue::from_static("Retry-After"),
            );
            r.headers_mut()
                .insert(header::VARY, HeaderValue::from_static("Origin"));
        }
        return r;
    }
    if result != "ok" {
        return error(StatusCode::SERVICE_UNAVAILABLE, "temporarily_unavailable");
    }
    if id.parse::<uuid::Uuid>().is_err() {
        return error(StatusCode::NOT_FOUND, "form_unavailable");
    }
    let method = request.method().clone();
    if method != Method::POST && method != Method::OPTIONS {
        return error(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed");
    }
    let headers = request.headers().clone();
    let Ok(Ok(body)) = tokio::time::timeout(
        Duration::from_secs(10),
        to_bytes(request.into_body(), 20_000),
    )
    .await
    else {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "request_too_large");
    };
    let mut url = match reqwest::Url::parse(&c.receiver) {
        Ok(v) => v,
        Err(_) => return error(StatusCode::SERVICE_UNAVAILABLE, "temporarily_unavailable"),
    };
    url.query_pairs_mut().append_pair("form", &id);
    let mut outgoing = c
        .client
        .request(method, url)
        .header("x-forms-ingress-secret", &c.secret)
        .body(body);
    for name in [
        header::ORIGIN,
        header::REFERER,
        header::CONTENT_TYPE,
        header::ACCEPT,
    ] {
        if let Some(v) = headers.get(&name) {
            outgoing = outgoing.header(name, v);
        }
    }
    let Ok(response) = outgoing.send().await else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "temporarily_unavailable");
    };
    let status = response.status();
    let received = response.headers().clone();
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            return error(StatusCode::SERVICE_UNAVAILABLE, "temporarily_unavailable");
        };
        if body.len() + chunk.len() > 32_768 {
            return error(StatusCode::SERVICE_UNAVAILABLE, "temporarily_unavailable");
        }
        body.extend_from_slice(&chunk);
    }
    let mut result = Response::new(Body::from(body));
    *result.status_mut() = status;
    for name in [
        header::CONTENT_TYPE,
        header::CACHE_CONTROL,
        header::VARY,
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        header::ACCESS_CONTROL_ALLOW_METHODS,
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        header::RETRY_AFTER,
    ] {
        if let Some(value) = received.get(&name) {
            result.headers_mut().insert(name, value.clone());
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn untrusted_forwarding_headers_are_ignored_and_fly_identity_is_unambiguous() {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", HeaderValue::from_static("192.0.2.10"));
        assert_eq!(client_ip(&h), None);
        h.insert("fly-client-ip", HeaderValue::from_static("192.0.2.20"));
        assert_eq!(client_ip(&h), Some("192.0.2.20".parse().unwrap()));
        h.append("fly-client-ip", HeaderValue::from_static("192.0.2.21"));
        assert_eq!(client_ip(&h), None);
    }
    #[test]
    fn missing_configuration_is_closed() {
        let mut c = Config::from_env();
        c.trusted_fly = false;
        assert!(!c.ready());
    }
    #[tokio::test]
    async fn forwards_only_allowed_headers_and_preserves_acceptance() {
        use tower::ServiceExt;
        let fake = Router::new()
            .route(
                "/rest/v1/rpc/charge_form_client",
                axum::routing::post(|| async { axum::Json("ok") }),
            )
            .route(
                "/receiver",
                any(|headers: HeaderMap, body: axum::body::Bytes| async move {
                    assert_eq!(
                        headers.get("x-forms-ingress-secret").unwrap(),
                        "s".repeat(48).as_str()
                    );
                    assert!(headers.get("x-forwarded-for").is_none());
                    assert!(headers.get("authorization").is_none());
                    assert_eq!(
                        headers.get(header::ORIGIN).unwrap(),
                        "https://www.example.com"
                    );
                    assert_eq!(body, r#"{"submission_id":"same"}"#);
                    (
                        [(
                            header::ACCESS_CONTROL_ALLOW_ORIGIN,
                            "https://www.example.com",
                        )],
                        axum::Json(serde_json::json!({"ok":true,"duplicate":true})),
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, fake).await.unwrap() });
        let mut c = Config::from_env();
        c.trusted_fly = true;
        c.allow_test_loopback = true;
        c.receiver = format!("{base}/receiver");
        c.db = base;
        c.secret = "s".repeat(48);
        c.hash_key = "h".repeat(48);
        c.service_key = "test".into();
        let app = Router::new()
            .route("/public/forms/{form_id}", any(forward))
            .with_state(c);
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/public/forms/00000000-0000-0000-0000-000000000001")
                    .header("fly-client-ip", "192.0.2.1")
                    .header("x-forwarded-for", "spoofed")
                    .header("authorization", "untrusted")
                    .header(header::ORIGIN, "https://www.example.com")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"submission_id":"same"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .unwrap(),
            "https://www.example.com"
        );
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({"ok":true,"duplicate":true})
        );
        server.abort();
    }
    #[tokio::test]
    #[ignore = "requires disposable PostgREST, database, and Edge fixture"]
    async fn coupled_disposable_postgrest_receiver() {
        let db = std::env::var("FORMS_TEST_DB").expect("disposable PostgREST gateway required");
        let receiver =
            std::env::var("FORMS_TEST_RECEIVER").expect("disposable Edge receiver required");
        let key = std::env::var("FORMS_TEST_SERVICE_JWT").expect("disposable service JWT required");
        let mut c = Config::from_env();
        c.trusted_fly = true;
        c.allow_test_loopback = true;
        c.db = db;
        c.receiver = receiver.clone();
        c.service_key = key;
        c.secret = "s".repeat(48);
        c.hash_key = "h".repeat(48);
        let mut urls = Vec::new();
        let mut servers = Vec::new();
        for _ in 0..2 {
            let mut instance = c.clone();
            instance.slots = Arc::new(tokio::sync::Semaphore::new(32));
            let app = Router::new()
                .route("/public/forms/{form_id}", any(forward))
                .with_state(instance);
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            urls.push(format!(
                "http://{}/public/forms/00000000-0000-0000-0000-000000000003",
                listener.local_addr().unwrap()
            ));
            servers.push(tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap()
            }));
        }
        let client = reqwest::Client::new();
        assert_eq!(
            client
                .post(format!(
                    "{receiver}?form=00000000-0000-0000-0000-000000000003"
                ))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        let send = |url: String, method: Method| {
            client
                .request(method, url)
                .header("fly-client-ip", "192.0.2.1")
                .header(header::ORIGIN, "https://www.example.com")
        };
        let preflight = send(urls[0].clone(), Method::OPTIONS).send().await.unwrap();
        assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
        let payload = serde_json::json!({"submission_id":"00000000-0000-0000-0000-000000000005", "name":"Ada", "email":"ada@example.com"});
        let first = send(urls[0].clone(), Method::POST)
            .json(&payload)
            .send()
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(
            first.json::<serde_json::Value>().await.unwrap()["duplicate"],
            false
        );
        let retry = send(urls[1].clone(), Method::POST)
            .json(&payload)
            .send()
            .await
            .unwrap();
        assert_eq!(retry.status(), StatusCode::OK);
        assert_eq!(
            retry.json::<serde_json::Value>().await.unwrap()["duplicate"],
            true
        );
        for _ in 0..97 {
            assert_eq!(
                send(urls[0].clone(), Method::OPTIONS)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::NO_CONTENT
            );
        }
        assert_eq!(
            send(urls[1].clone(), Method::OPTIONS)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        let mut receiver_down = c.clone();
        receiver_down.receiver = "http://127.0.0.1:1".into();
        let down_app = Router::new()
            .route("/public/forms/{form_id}", any(forward))
            .with_state(receiver_down);
        use tower::ServiceExt;
        let response = down_app
            .oneshot(
                Request::builder()
                    .method("OPTIONS")
                    .uri("/public/forms/00000000-0000-0000-0000-000000000003")
                    .header("fly-client-ip", "192.0.2.2")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let mut bad = c;
        bad.db = "http://127.0.0.1:1".into();
        let app = Router::new()
            .route("/public/forms/{form_id}", any(forward))
            .with_state(bad);
        let r = app
            .oneshot(
                Request::builder()
                    .uri("/public/forms/00000000-0000-0000-0000-000000000003")
                    .header("fly-client-ip", "192.0.2.1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE);
        for server in servers {
            server.abort();
        }
    }
}
