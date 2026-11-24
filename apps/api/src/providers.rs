//! Owner-scoped provider operations; consent and grant storage remain on the web origin.
use axum::{
    Json, Router,
    extract::Path,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rmcp::model::CallToolResult;

pub(crate) fn router() -> Router {
    Router::new()
        .route("/websites/{id}/search/owner-inspect", post(owner_inspect))
        .route(
            "/providers/google/connection",
            get(google_status).delete(google_disconnect),
        )
        .route(
            "/providers/bing/connection",
            get(bing_status).delete(bing_disconnect),
        )
}

// This route uses the owner bridge; Nitro alone supplies the Google credential.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct OwnerInspectionInput {
    site_url: String,
    url: String,
}

async fn owner_inspect(
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<OwnerInspectionInput>,
) -> Response {
    let Some(id) = uuid::Uuid::parse_str(&id).ok().filter(|_| id.len() == 36) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    rest_response(crate::mcp::owner_inspection_call(&headers, id, input.site_url, input.url).await)
}

async fn google_status(headers: HeaderMap) -> Response {
    connection(headers, reqwest::Method::GET, "/api/google/connection").await
}
async fn google_disconnect(headers: HeaderMap) -> Response {
    connection(headers, reqwest::Method::DELETE, "/api/google/connection").await
}
async fn bing_status(headers: HeaderMap) -> Response {
    connection(headers, reqwest::Method::GET, "/api/bing/connection").await
}
async fn bing_disconnect(headers: HeaderMap) -> Response {
    connection(headers, reqwest::Method::DELETE, "/api/bing/connection").await
}

async fn connection(headers: HeaderMap, method: reqwest::Method, path: &'static str) -> Response {
    rest_response(crate::mcp::web_management_call(&headers, method, path, None).await)
}

// Adapt the shared MCP bridge envelope without changing its error mapping.
fn rest_response(result: CallToolResult) -> Response {
    let failed = result.is_error == Some(true);
    let mut value = result.structured_content.unwrap_or_else(|| {
        serde_json::json!({
            "code": "data_unavailable", "error": "Provider data is temporarily unavailable."
        })
    });
    let status = if failed {
        value
            .get("status")
            .and_then(serde_json::Value::as_u64)
            .and_then(|status| u16::try_from(status).ok())
            .and_then(|status| StatusCode::from_u16(status).ok())
            .unwrap_or_else(|| {
                if value["code"] == "unauthorized" {
                    StatusCode::UNAUTHORIZED
                } else {
                    StatusCode::SERVICE_UNAVAILABLE
                }
            })
    } else {
        StatusCode::OK
    };
    if failed {
        value["status"] = serde_json::json!(status.as_u16());
    }
    (status, Json(value)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn owner_inspection_without_identity_never_forwards() {
        let response = router()
            .oneshot(
                Request::post(
                    "/websites/00000000-0000-0000-0000-000000000001/search/owner-inspect",
                )
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"site_url":"sc-domain:example.com","url":"https://example.com/"}"#,
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn local_provider_fixtures_preserve_json_and_map_errors() {
        let upstream = Router::new().route("/{*path}", axum::routing::any(
            |headers: HeaderMap, method: reqwest::Method, uri: axum::http::Uri| async move {
                assert_eq!(headers["authorization"], "Bearer owner-token");
                assert!(!headers.contains_key("cookie"));
                assert!(!headers.contains_key("origin"));
                assert!(!headers.contains_key("x-google-access-token"));
                let path = uri.path();
                if let Some(status) = path.strip_prefix("/error/") {
                    return (StatusCode::from_u16(status.parse().unwrap()).unwrap(), Json(serde_json::json!({"statusCode": status, "message":"PRIVATE"})));
                }
                let value = if method == reqwest::Method::DELETE {
                    serde_json::json!({"connected":false})
                } else if path.contains("google") {
                    serde_json::json!({"connected":true,"configured":true,"analytics":true,"search":false,"business":false,"reauthorizationRequired":false})
                } else {
                    serde_json::json!({"configured":true,"connected":false,"reauthorizationRequired":true})
                };
                (StatusCode::OK, Json(value))
            }
        ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer owner-token".parse().unwrap());
        headers.insert("cookie", "secret".parse().unwrap());
        headers.insert("origin", "https://dashboard.example".parse().unwrap());
        for provider in ["google", "bing"] {
            for method in [reqwest::Method::GET, reqwest::Method::DELETE] {
                let result = crate::mcp::web_management_request(
                    &origin,
                    &headers,
                    method.clone(),
                    &format!("/api/{provider}/connection"),
                    None,
                )
                .await;
                let expected = result.structured_content.clone().unwrap();
                let response = rest_response(result);
                assert_eq!(response.status(), StatusCode::OK);
                let value: serde_json::Value =
                    serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap())
                        .unwrap();
                assert_eq!(value, expected);
                if method == reqwest::Method::DELETE {
                    assert_eq!(value, serde_json::json!({"connected":false}));
                }
            }
        }
        for (status, code) in [
            (400, "invalid_request"),
            (422, "invalid_request"),
            (401, "authorization_required"),
            (403, "access_denied"),
            (404, "access_denied"),
            (429, "quota_exceeded"),
            (503, "provider_unavailable"),
            (302, "provider_unavailable"),
        ] {
            let result = crate::mcp::web_management_request(
                &origin,
                &headers,
                reqwest::Method::GET,
                &format!("/error/{status}"),
                None,
            )
            .await;
            let response = rest_response(result);
            assert_eq!(response.status().as_u16(), status);
            let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
            let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(value["code"], code);
            assert!(!String::from_utf8_lossy(&bytes).contains("PRIVATE"));
        }
        server.abort();
    }

    #[tokio::test]
    async fn missing_identity_and_unsupported_routes_fail_locally() {
        for provider in ["google", "bing"] {
            for method in ["GET", "DELETE", "POST"] {
                let response = router()
                    .oneshot(
                        Request::builder()
                            .method(method)
                            .uri(format!("/providers/{provider}/connection"))
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(
                    response.status(),
                    if method == "POST" {
                        StatusCode::METHOD_NOT_ALLOWED
                    } else {
                        StatusCode::UNAUTHORIZED
                    }
                );
            }
        }
    }
}
