//! Service-authenticated Seosmith ingestion and owner-scoped report reads.
use crate::websites::WebsiteStore;
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    delivery_id: Uuid,
    sha256: String,
    report_json: String,
}

pub(crate) fn ingest_router(store: WebsiteStore) -> Router {
    Router::new()
        .route("/integrations/seosmith/audits", post(ingest))
        .route("/integrations/seosmith/capabilities", get(capabilities))
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        .with_state(store)
}
pub(crate) fn read_router(store: WebsiteStore) -> Router {
    Router::new()
        .route("/websites/{id}/seo/audits", get(read))
        .route("/websites/{id}/seo/audits/import", post(import))
        .route("/websites/{id}/seo/audits/{run}", get(detail))
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        .with_state(store)
}
async fn capabilities(State(store): State<WebsiteStore>) -> Response {
    match store.seosmith_capabilities().await {
        Ok(value) => ([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response(),
        Err(error) => error.into_response(),
    }
}
async fn ingest(
    State(store): State<WebsiteStore>,
    headers: HeaderMap,
    Json(body): Json<Envelope>,
) -> Response {
    let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|s| s.len() >= 32 && s.len() <= 512)
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if headers.get("idempotency-key").and_then(|h| h.to_str().ok())
        != Some(body.delivery_id.to_string().as_str())
        || body.report_json.len() > 16 * 1024 * 1024
        || body.sha256.len() != 64
        || !body
            .sha256
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_delivery"})),
        )
            .into_response();
    }
    let response=store.ingest_seosmith(json!({"p_token":token,"p_delivery_id":body.delivery_id,"p_sha256":body.sha256,"p_report_json":body.report_json})).await;
    match response {
        Ok(value) => ([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response(),
        Err(e) => e.into_response(),
    }
}
#[derive(Deserialize)]
struct PageQuery {
    limit: Option<u32>,
    before: Option<String>,
    before_id: Option<Uuid>,
}
async fn read(
    State(store): State<WebsiteStore>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(q): Query<PageQuery>,
) -> Response {
    match store.rpc(&headers,"seosmith_audit_history",json!({"p_website_id":id,"p_limit":q.limit.unwrap_or(50),"p_before":q.before,"p_before_id":q.before_id})).await {
        Ok(value)=>([(header::CACHE_CONTROL,"no-store")],Json(value)).into_response(),Err(e)=>e.into_response()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Import {
    report_json: String,
}
async fn import(
    State(store): State<WebsiteStore>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Import>,
) -> Response {
    if body.report_json.len() > 16 * 1024 * 1024 {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    match store
        .rpc(
            &headers,
            "import_seosmith_audit",
            json!({"p_website_id":id,"p_report_json":body.report_json}),
        )
        .await
    {
        Ok(value) => ([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response(),
        Err(e) => e.into_response(),
    }
}
async fn detail(
    State(store): State<WebsiteStore>,
    headers: HeaderMap,
    Path((id, run)): Path<(Uuid, Uuid)>,
) -> Response {
    match store.seosmith_detail(&headers, id, run).await {
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Ok(Some(bytes)) => (
            [
                (header::CACHE_CONTROL, "no-store"),
                (header::CONTENT_TYPE, "application/json"),
            ],
            bytes,
        )
            .into_response(),
        Err(e) => e.into_response(),
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
    // Local profiling hook: the mock upstream is a separate process so its fixture
    // allocation is excluded from the API process RSS.
    #[tokio::test]
    #[ignore = "requires the local large-report profiling harness"]
    async fn profile_detail_http() {
        let url = std::env::var("HTP_PROFILE_UPSTREAM").unwrap();
        let app = read_router(WebsiteStore::new(&url, "publishable"));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut response = reqwest::Client::new()
            .get(format!("http://{addr}/websites/00000000-0000-0000-0000-000000000001/seo/audits/00000000-0000-0000-0000-000000000002"))
            .header("authorization", "Bearer synthetic")
            .send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let mut count = 0;
        while let Some(chunk) = response.chunk().await.unwrap() {
            count += chunk.len();
        }
        assert!(count > 30_000_000);
        server.abort();
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires the local large-report profiling harness"]
    async fn profile_ingest_http() {
        let url = std::env::var("HTP_PROFILE_UPSTREAM").unwrap();
        let payload = std::env::var("HTP_PROFILE_ENVELOPE").unwrap();
        let app = ingest_router(WebsiteStore::new(&url, "publishable"));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let result = tokio::task::spawn_blocking(move || {
            std::process::Command::new("curl")
                .args([
                    "--silent",
                    "--show-error",
                    "--fail",
                    "--max-time",
                    "25",
                    "-H",
                    "content-type: application/json",
                    "-H",
                    "idempotency-key: 00000000-0000-0000-0000-000000000002",
                    "-H",
                    "authorization: Bearer xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
                    "--data-binary",
                    &format!("@{payload}"),
                    &format!("http://{addr}/integrations/seosmith/audits"),
                ])
                .output()
                .unwrap()
        })
        .await
        .unwrap();
        if std::env::var_os("HTP_PROFILE_EXPECT_TIMEOUT").is_some() {
            assert_eq!(result.status.code(), Some(22));
            server.abort();
            return;
        }
        assert!(result.status.success());
        let receipt: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(receipt["accepted"], true);
        assert_eq!(receipt["sha256"], std::env::var("HTP_PROFILE_SHA").unwrap());
        assert_eq!(
            receipt["delivery_id"],
            "00000000-0000-0000-0000-000000000002"
        );
        server.abort();
    }
    #[tokio::test]
    async fn detail_preserves_auth_json_null_and_error_contract() {
        for (upstream_status, upstream_body, expected) in [
            (StatusCode::OK, " \n null ", StatusCode::NOT_FOUND),
            (
                StatusCode::OK,
                "{\"report\":{\"items\":[1,2]},\"report_json\":\"{ }\"}",
                StatusCode::OK,
            ),
            (StatusCode::OK, "{invalid", StatusCode::SERVICE_UNAVAILABLE),
            (StatusCode::UNAUTHORIZED, "{}", StatusCode::UNAUTHORIZED),
            (StatusCode::FORBIDDEN, "{}", StatusCode::FORBIDDEN),
            (StatusCode::BAD_REQUEST, "{}", StatusCode::BAD_REQUEST),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "{}",
                StatusCode::SERVICE_UNAVAILABLE,
            ),
        ] {
            let rpc = Router::new().route(
                "/rest/v1/rpc/seosmith_audit_detail",
                post(
                    move |headers: HeaderMap, Json(body): Json<serde_json::Value>| async move {
                        assert_eq!(headers["apikey"], "publishable");
                        assert_eq!(headers["authorization"], "Bearer synthetic");
                        assert_eq!(body["p_website_id"], "00000000-0000-0000-0000-000000000001");
                        assert_eq!(
                            body["p_delivery_id"],
                            "00000000-0000-0000-0000-000000000002"
                        );
                        (upstream_status, upstream_body)
                    },
                ),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let store = WebsiteStore::new(
                &format!("http://{}", listener.local_addr().unwrap()),
                "publishable",
            );
            let server = tokio::spawn(async move { axum::serve(listener, rpc).await.unwrap() });
            let app = read_router(store);
            let request = || {
                Request::builder().uri("/websites/00000000-0000-0000-0000-000000000001/seo/audits/00000000-0000-0000-0000-000000000002")
            };
            let missing = app
                .clone()
                .oneshot(request().body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);
            let response = app
                .oneshot(
                    request()
                        .header("authorization", "Bearer synthetic")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
            if expected == StatusCode::OK {
                assert_eq!(response.headers()["content-type"], "application/json");
                assert_eq!(response.headers()["cache-control"], "no-store");
                assert_eq!(
                    &to_bytes(response.into_body(), 4096).await.unwrap()[..],
                    upstream_body.as_bytes()
                );
            }
            server.abort();
        }
    }
    #[tokio::test]
    async fn capabilities_reflect_installed_database_and_fail_closed() {
        for available in [true, false] {
            let rpc = Router::new().route(
                "/rest/v1/rpc/seosmith_receiver_capabilities",
                post(move |headers: HeaderMap| async move {
                    assert_eq!(headers["apikey"], "publishable");
                    assert!(!headers.contains_key("authorization"));
                    if available {
                        (
                            StatusCode::OK,
                            Json(json!({"schema_versions":[1],"max_report_bytes":16_777_216})),
                        )
                    } else {
                        (
                            StatusCode::NOT_FOUND,
                            Json(json!({"message":"missing migration"})),
                        )
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let store = WebsiteStore::new(
                &format!("http://{}", listener.local_addr().unwrap()),
                "publishable",
            );
            let server = tokio::spawn(async move { axum::serve(listener, rpc).await.unwrap() });
            let response = ingest_router(store)
                .oneshot(
                    Request::builder()
                        .uri("/integrations/seosmith/capabilities")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            if available {
                assert_eq!(response.status(), StatusCode::OK);
                assert_eq!(response.headers()["cache-control"], "no-store");
                let body: serde_json::Value =
                    serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap())
                        .unwrap();
                assert_eq!(body["schema_versions"], json!([1]));
            } else {
                assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            }
            server.abort();
        }
    }

    #[tokio::test]
    async fn delivery_requires_worker_credential_and_idempotency_key() {
        let app = ingest_router(WebsiteStore::new("http://127.0.0.1:1", "test"));
        let id = "00000000-0000-0000-0000-000000000001";
        let payload = json!({"delivery_id":id,"sha256":"a".repeat(64),"report_json":"{}"});
        let request = || {
            Request::builder()
                .method("POST")
                .uri("/integrations/seosmith/audits")
                .header("content-type", "application/json")
        };
        let response = app
            .clone()
            .oneshot(request().body(Body::from(payload.to_string())).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = app
            .oneshot(
                request()
                    .header("authorization", format!("Bearer {}", "x".repeat(32)))
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    #[tokio::test]
    async fn valid_envelope_is_forwarded_to_only_the_credential_checked_rpc() {
        let id = "00000000-0000-0000-0000-000000000001";
        let rpc=Router::new().route("/rest/v1/rpc/ingest_seosmith_audit",post(|headers:HeaderMap,Json(body):Json<serde_json::Value>|async move {
            assert_eq!(headers["apikey"],"publishable");assert!(!headers.contains_key("authorization"));
            assert_eq!(body["p_token"],"x".repeat(32));
            assert_eq!(body["p_report_json"], include_str!("../../../supabase/tests/fixtures/seosmith-expanded.json"));
            Json(json!({"delivery_id":body["p_delivery_id"],"sha256":body["p_sha256"],"accepted":true}))
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, rpc).await.unwrap() });
        let app = ingest_router(WebsiteStore::new(&url, "publishable"));
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/integrations/seosmith/audits")
                    .header("content-type", "application/json")
                    .header("idempotency-key", id)
                    .header("authorization", format!("Bearer {}", "x".repeat(32)))
                    .body(Body::from(
                        json!({"delivery_id":id,"sha256":"a".repeat(64),"report_json":include_str!("../../../supabase/tests/fixtures/seosmith-expanded.json")})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(body["accepted"], true);
        server.abort();
    }
    #[tokio::test]
    async fn database_rejection_never_becomes_a_successful_receipt() {
        let rpc = Router::new().route(
            "/rest/v1/rpc/ingest_seosmith_audit",
            post(|| async {
                (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"code":"22023","message":"report_limit"})),
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, rpc).await.unwrap() });
        let app = ingest_router(WebsiteStore::new(&url, "publishable"));
        let id = "00000000-0000-0000-0000-000000000001";
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/integrations/seosmith/audits")
                    .header("content-type", "application/json")
                    .header("idempotency-key", id)
                    .header("authorization", format!("Bearer {}", "x".repeat(32)))
                    .body(Body::from(
                        json!({"delivery_id":id,"sha256":"a".repeat(64),"report_json":"{}"})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert!(body.get("accepted").is_none());
        server.abort();
    }
}
