//! Fixed demo operations, independent of the MCP transport and its Origin policy.
use axum::{Json, http::header};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Transport {
    Rest,
    Mcp,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Operation {
    #[default]
    Call,
    List,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DemoRequest {
    transport: Transport,
    #[serde(default)]
    operation: Operation,
}

fn demo(
    request: DemoRequest,
    secured: bool,
) -> ([(header::HeaderName, &'static str); 1], Json<Value>) {
    let body = match request.transport {
        Transport::Rest => serde_json::json!(if secured {
            super::secured_message()
        } else {
            super::message()
        }),
        Transport::Mcp => {
            super::mcp::playground_demo(secured, matches!(request.operation, Operation::List))
        }
    };
    ([(header::CACHE_CONTROL, "no-store")], Json(body))
}

pub(crate) async fn public(Json(request): Json<DemoRequest>) -> impl axum::response::IntoResponse {
    demo(request, false)
}
pub(crate) async fn secured(Json(request): Json<DemoRequest>) -> impl axum::response::IntoResponse {
    demo(request, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        middleware,
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn local_preview_cors_preserves_real_auth_errors() {
        let origin = "http://127.0.0.1:8788";
        let cors = crate::dashboard_cors::DashboardCors::parse_origin(origin).unwrap();
        let app = crate::app().layer(middleware::from_fn_with_state(
            cors,
            crate::dashboard_cors::layer,
        ));
        for (path, expected) in [
            ("/playground/public", StatusCode::OK),
            ("/playground/secured", StatusCode::UNAUTHORIZED),
        ] {
            for candidate in [origin, "http://127.0.0.1:8789", "https://evil.example"] {
                let response = app
                    .clone()
                    .oneshot(
                        Request::post(path)
                            .header(header::ORIGIN, candidate)
                            .header(header::CONTENT_TYPE, "application/json")
                            .body(Body::from(r#"{"transport":"rest"}"#))
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(response.status(), expected);
                assert_eq!(
                    response
                        .headers()
                        .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN),
                    candidate == origin
                );
                assert!(
                    !response
                        .headers()
                        .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
                );
                assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            }
        }
    }
}
