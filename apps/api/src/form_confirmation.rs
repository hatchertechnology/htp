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
use std::time::Duration;

#[derive(Clone)]
struct Config {
    enabled: bool,
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
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_none_or(|v| v != "application/json")
    {
        return response(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let bytes =
        match tokio::time::timeout(Duration::from_secs(10), to_bytes(request.into_body(), 1024))
            .await
        {
            Ok(Ok(bytes)) => bytes,
            _ => return response(StatusCode::BAD_REQUEST, "invalid_request"),
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
    if let Ok(result) = result {
        if result.status().is_success() {
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
