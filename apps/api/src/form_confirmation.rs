//! Public challenge confirmation only; no invitations or delivery work.
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Request, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use serde::Deserialize;
use serde_json::json;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

// Per-process bounds, shared by all router clones; no client/token keyed state.
const MAX_IN_FLIGHT: usize = 4;
const ATTEMPTS_PER_WINDOW: u32 = 30;
const ADMISSION_WINDOW: Duration = Duration::from_secs(60);

struct Window {
    started: Instant,
    attempts: u32,
}
impl Window {
    fn charge(&mut self, now: Instant) -> bool {
        if now.duration_since(self.started) >= ADMISSION_WINDOW {
            self.started = now;
            self.attempts = 0;
        }
        if self.attempts >= ATTEMPTS_PER_WINDOW {
            return false;
        }
        self.attempts += 1;
        true
    }
}
struct Admission {
    slots: tokio::sync::Semaphore,
    window: Mutex<Window>,
}
impl Admission {
    fn new() -> Self {
        Self {
            slots: tokio::sync::Semaphore::new(MAX_IN_FLIGHT),
            window: Mutex::new(Window {
                started: Instant::now(),
                attempts: 0,
            }),
        }
    }
    fn acquire(&self) -> Option<tokio::sync::SemaphorePermit<'_>> {
        // No waiting queue, including for the short rate-counter critical section.
        let permit = self.slots.try_acquire().ok()?;
        if !self.window.try_lock().ok()?.charge(Instant::now()) {
            return None;
        }
        Some(permit)
    }
}
fn rate_limited() -> Response {
    let mut result = response(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    result
        .headers_mut()
        .insert(header::RETRY_AFTER, header::HeaderValue::from_static("60"));
    result
}

#[derive(Clone)]
struct Config {
    enabled: bool,
    admission: Arc<Admission>,
    db: String,
    key: String,
    client: reqwest::Client,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    recipient_id: String,
    token: String,
}
fn valid(input: &Input) -> bool {
    input.recipient_id.len() == 36
        && uuid::Uuid::parse_str(&input.recipient_id).is_ok()
        && input.token.len() == 64
        && input
            .token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn response(status: StatusCode, code: &str) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"code":code})),
    )
        .into_response()
}
pub fn router() -> Router {
    Router::new()
        .route("/forms/confirm", post(confirm))
        .with_state(Config {
            admission: Arc::new(Admission::new()),
            enabled: std::env::var("HTP_FORMS_CONFIRM_API").as_deref() == Ok("true"),
            db: std::env::var("SUPABASE_URL").unwrap_or_default(),
            key: std::env::var("FORMS_SERVICE_KEY").unwrap_or_default(),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .timeout(Duration::from_secs(10))
                .build()
                .expect("confirmation client"),
        })
}
async fn confirm(State(config): State<Config>, request: Request) -> Response {
    if !config.enabled || config.db.is_empty() || config.key.is_empty() {
        return response(StatusCode::NOT_FOUND, "forms_confirmation_disabled");
    }
    // Hold through body read, RPC and bounded response read; cancellation drops it.
    let Some(_permit) = config.admission.acquire() else {
        return rate_limited();
    };
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_none_or(|v| v != "application/json")
    {
        return response(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let Ok(Ok(bytes)) =
        tokio::time::timeout(Duration::from_secs(10), to_bytes(request.into_body(), 1024)).await
    else {
        return response(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let input: Input = match serde_json::from_slice(&bytes) {
        Ok(input) if valid(&input) => input,
        _ => return response(StatusCode::BAD_REQUEST, "invalid_request"),
    };
    // One attempt. Never log the request, token, or upstream error body.
    let result = config
        .client
        .post(format!(
            "{}/rest/v1/rpc/confirm_form_recipient",
            config.db.trim_end_matches('/')
        ))
        .header("apikey", &config.key)
        .bearer_auth(&config.key)
        .json(&json!({"p_recipient_id":input.recipient_id,"p_token":input.token}))
        .send()
        .await;
    if let Ok(result) = result
        && result.status().is_success()
    {
        // Bound the response and its read deadline as well as the request.
        if result.content_length().is_some_and(|n| n > 16) {
            return response(StatusCode::SERVICE_UNAVAILABLE, "confirmation_unknown");
        }
        let read = async {
            let mut result = result;
            let mut bytes = Vec::new();
            while let Some(chunk) = result.chunk().await? {
                if bytes.len() + chunk.len() > 16 {
                    return Ok::<_, reqwest::Error>(None);
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(serde_json::from_slice::<bool>(&bytes).ok())
        };
        match tokio::time::timeout(Duration::from_secs(10), read).await {
            Ok(Ok(Some(true))) => {
                return (
                    [(header::CACHE_CONTROL, "no-store")],
                    Json(json!({"ok":true})),
                )
                    .into_response();
            }
            Ok(Ok(Some(false))) => {
                return response(StatusCode::BAD_REQUEST, "invalid_confirmation");
            }
            _ => {}
        }
    }
    response(StatusCode::SERVICE_UNAVAILABLE, "confirmation_unknown")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request as HttpRequest};
    use tower::ServiceExt;
    async fn fixture(
        enabled: bool,
        upstream: &'static str,
        status: StatusCode,
    ) -> (Router, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        fixture_with_admission(enabled, upstream, status, Arc::new(Admission::new())).await
    }
    async fn fixture_with_admission(
        enabled: bool,
        upstream: &'static str,
        status: StatusCode,
        admission: Arc<Admission>,
    ) -> (Router, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = calls.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let db = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/rest/v1/rpc/confirm_form_recipient",
                    post(move || {
                        let count = count.clone();
                        async move {
                            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            (status, upstream)
                        }
                    }),
                ),
            )
            .await
            .unwrap();
        });
        let config = Config {
            enabled,
            admission,
            db,
            key: "fixture".into(),
            client: reqwest::Client::builder()
                .retry(reqwest::retry::never())
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap(),
        };
        (
            Router::new()
                .route("/forms/confirm", post(confirm))
                .with_state(config),
            calls,
        )
    }
    fn body() -> String {
        json!({"recipient_id":"12345678-1234-1234-1234-123456789abc","token":"a".repeat(64)})
            .to_string()
    }
    async fn call(app: Router, body: String) -> Response {
        app.oneshot(
            HttpRequest::builder()
                .method("POST")
                .uri("/forms/confirm")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap()
    }
    #[tokio::test]
    async fn disabled_and_invalid_never_forward() {
        let (app, calls) = fixture(false, "true", StatusCode::OK).await;
        assert_eq!(call(app, body()).await.status(), StatusCode::NOT_FOUND);
        let (app, other) = fixture(true, "true", StatusCode::OK).await;
        for body in ["{".into(), "x".repeat(1025), "{}".into()] {
            assert_eq!(
                call(app.clone(), body).await.status(),
                StatusCode::BAD_REQUEST
            );
        }
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(other.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn maps_only_definite_boolean_without_retry_or_raw_errors() {
        for (upstream, status, expected) in [
            ("true", StatusCode::OK, StatusCode::OK),
            ("false", StatusCode::OK, StatusCode::BAD_REQUEST),
            (
                "{\"ok\":true}",
                StatusCode::OK,
                StatusCode::SERVICE_UNAVAILABLE,
            ),
            (
                "sensitive provider error",
                StatusCode::INTERNAL_SERVER_ERROR,
                StatusCode::SERVICE_UNAVAILABLE,
            ),
        ] {
            let (app, calls) = fixture(true, upstream, status).await;
            let response = call(app, body()).await;
            assert_eq!(response.status(), expected);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            let bytes = to_bytes(response.into_body(), 1024).await.unwrap();
            assert!(!String::from_utf8_lossy(&bytes).contains("sensitive"));
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        }
    }
    #[tokio::test]
    async fn exact_dashboard_cors_only() {
        let (app, _) = fixture(false, "true", StatusCode::OK).await;
        let app = app.layer(axum::middleware::from_fn_with_state(
            crate::dashboard_cors::DashboardCors::parse_origin("https://dashboard.example")
                .unwrap(),
            crate::dashboard_cors::layer,
        ));
        for origin in [
            "https://dashboard.example",
            "https://dashboard.example.evil",
            "null",
        ] {
            let response = app
                .clone()
                .oneshot(
                    HttpRequest::builder()
                        .method("OPTIONS")
                        .uri("/forms/confirm")
                        .header("origin", origin)
                        .header("access-control-request-method", "POST")
                        .header("access-control-request-headers", "content-type")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response
                    .headers()
                    .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN),
                origin == "https://dashboard.example"
            );
            assert!(
                !response
                    .headers()
                    .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
            );
        }
    }
    #[test]
    fn window_is_bounded_and_recovers_only_at_boundary() {
        let start = Instant::now();
        let mut window = Window {
            started: start,
            attempts: 0,
        };
        for _ in 0..ATTEMPTS_PER_WINDOW {
            assert!(window.charge(start));
        }
        assert!(!window.charge(start));
        assert!(
            !window.charge(
                start
                    + ADMISSION_WINDOW
                        .checked_sub(Duration::from_nanos(1))
                        .unwrap()
            )
        );
        assert!(window.charge(start + ADMISSION_WINDOW));
        assert_eq!(window.attempts, 1);
    }

    #[tokio::test]
    async fn repeated_valid_shapes_share_budget_and_return_safe_cors_429() {
        let (app, calls) = fixture(true, "false", StatusCode::OK).await;
        let app = app.layer(axum::middleware::from_fn_with_state(
            crate::dashboard_cors::DashboardCors::parse_origin("https://dashboard.example")
                .unwrap(),
            crate::dashboard_cors::layer,
        ));
        for i in 0..ATTEMPTS_PER_WINDOW {
            // Rotate both identifiers: no per-key map, no bypass by changing invitations.
            let input = json!({"recipient_id": format!("{:08x}-1234-1234-1234-123456789abc", i),
                "token": format!("{:064x}", i)})
            .to_string();
            assert_eq!(
                call(app.clone(), input).await.status(),
                StatusCode::BAD_REQUEST
            );
        }
        for origin in [
            "https://dashboard.example",
            "https://dashboard.example.evil",
            "null",
        ] {
            let unread = futures_util::stream::poll_fn(
                |_| -> std::task::Poll<Option<Result<axum::body::Bytes, std::io::Error>>> {
                    panic!("rate-limited body must not be polled")
                },
            );
            let response = app
                .clone()
                .oneshot(
                    HttpRequest::builder()
                        .method("POST")
                        .uri("/forms/confirm")
                        .header("content-type", "application/json")
                        .header("origin", origin)
                        .body(Body::from_stream(unread))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(response.headers()[header::RETRY_AFTER], "60");
            assert_eq!(
                response
                    .headers()
                    .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN),
                origin == "https://dashboard.example"
            );
            assert!(
                !response
                    .headers()
                    .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
            );
            assert_eq!(
                &to_bytes(response.into_body(), 1024).await.unwrap()[..],
                br#"{"code":"rate_limited"}"#
            );
        }
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            ATTEMPTS_PER_WINDOW as usize
        );
        // Preflight stays available even after exhaustion.
        let response = app
            .oneshot(
                HttpRequest::builder()
                    .method("OPTIONS")
                    .uri("/forms/confirm")
                    .header("origin", "https://dashboard.example")
                    .header("access-control-request-method", "POST")
                    .header("access-control-request-headers", "content-type")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn saturation_rejects_before_body_poll_and_disabled_still_returns_404() {
        let admission = Arc::new(Admission::new());
        let held = admission
            .slots
            .acquire_many(u32::try_from(MAX_IN_FLIGHT).unwrap())
            .await
            .unwrap();
        let (app, calls) =
            fixture_with_admission(true, "true", StatusCode::OK, admission.clone()).await;
        let unread = futures_util::stream::poll_fn(
            |_| -> std::task::Poll<Option<Result<axum::body::Bytes, std::io::Error>>> {
                panic!("rejected request body must not be polled")
            },
        );
        let response = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/forms/confirm")
                    .header("content-type", "application/json")
                    .body(Body::from_stream(unread))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(admission.window.lock().unwrap().attempts, 0);
        let (disabled, _) =
            fixture_with_admission(false, "true", StatusCode::OK, admission.clone()).await;
        assert_eq!(call(disabled, body()).await.status(), StatusCode::NOT_FOUND);
        drop(held);
        assert_eq!(
            call(app.clone(), "{}".into()).await.status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(admission.slots.available_permits(), MAX_IN_FLIGHT);
        assert_eq!(call(app, body()).await.status(), StatusCode::OK);
        assert_eq!(admission.slots.available_permits(), MAX_IN_FLIGHT);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn pending_bodies_hold_all_slots_and_abort_releases_them() {
        let admission = Arc::new(Admission::new());
        let (app, calls) =
            fixture_with_admission(true, "true", StatusCode::OK, admission.clone()).await;
        let (polled, mut received) = tokio::sync::mpsc::channel(MAX_IN_FLIGHT);
        let mut tasks = Vec::new();
        for _ in 0..MAX_IN_FLIGHT {
            let mut polled = Some(polled.clone());
            let stream = futures_util::stream::poll_fn(
                move |_| -> std::task::Poll<Option<Result<axum::body::Bytes, std::io::Error>>> {
                    if let Some(sender) = polled.take() {
                        sender.try_send(()).unwrap();
                    }
                    std::task::Poll::Pending
                },
            );
            let request = HttpRequest::builder()
                .method("POST")
                .uri("/forms/confirm")
                .header("content-type", "application/json")
                .body(Body::from_stream(stream))
                .unwrap();
            tasks.push(tokio::spawn(app.clone().oneshot(request)));
        }
        for _ in 0..MAX_IN_FLIGHT {
            tokio::time::timeout(Duration::from_secs(2), received.recv())
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(
            call(app.clone(), body()).await.status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        for task in tasks {
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        }
        assert_eq!(admission.slots.available_permits(), MAX_IN_FLIGHT);
        assert_eq!(
            admission.window.lock().unwrap().attempts,
            u32::try_from(MAX_IN_FLIGHT).unwrap()
        );
        assert_eq!(call(app, body()).await.status(), StatusCode::OK);
    }

    #[test]
    fn contention_fails_closed_and_cancellation_releases_slot() {
        let admission = Admission::new();
        let locked = admission.window.lock().unwrap();
        assert!(admission.acquire().is_none());
        assert_eq!(admission.slots.available_permits(), MAX_IN_FLIGHT);
        drop(locked);
        let permit = admission.acquire().unwrap();
        assert_eq!(admission.slots.available_permits(), MAX_IN_FLIGHT - 1);
        drop(permit);
        assert_eq!(admission.slots.available_permits(), MAX_IN_FLIGHT);
        // Returning capacity never refunds an attempt, including on cancellation.
        assert_eq!(admission.window.lock().unwrap().attempts, 1);
    }

    #[test]
    fn strict_input() {
        let value =
            json!({"recipient_id":"12345678-1234-1234-1234-123456789abc","token":"a".repeat(64)});
        assert!(valid(
            &serde_json::from_value::<Input>(value.clone()).unwrap()
        ));
        for token in ["A".repeat(64), "a".repeat(63), "g".repeat(64)] {
            let mut bad = value.clone();
            bad["token"] = json!(token);
            assert!(!valid(&serde_json::from_value::<Input>(bad).unwrap()));
        }
        let mut extra = value;
        extra["extra"] = json!(true);
        assert!(serde_json::from_value::<Input>(extra).is_err());
    }
}
