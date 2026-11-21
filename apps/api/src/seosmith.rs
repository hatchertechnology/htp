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
        .route("/websites/{id}/seo/audits/lifecycle", get(lifecycle))
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
    if body.report_json.len() > 4_952_756 {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({"error":"report_limit"})),
        )
            .into_response();
    }
    if headers.get("idempotency-key").and_then(|h| h.to_str().ok())
        != Some(body.delivery_id.to_string().as_str())
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
struct LifecycleQuery {
    entity_id: String,
    rule: String,
    limit: Option<u32>,
    before: Option<String>,
    before_id: Option<Uuid>,
}
async fn lifecycle(
    State(store): State<WebsiteStore>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(q): Query<LifecycleQuery>,
) -> Response {
    match store.rpc(&headers, "seosmith_lifecycle_history", json!({"p_website_id":id,"p_entity_id":q.entity_id,"p_rule":q.rule,"p_limit":q.limit.unwrap_or(50),"p_before":q.before,"p_before_id":q.before_id})).await {
        Ok(value) => ([(header::CACHE_CONTROL,"no-store")],Json(value)).into_response(), Err(e) => e.into_response()
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
    if body.report_json.len() > 4_952_756 {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({"error":"report_limit"})),
        )
            .into_response();
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
        Ok(Some(body)) => (
            [
                (header::CACHE_CONTROL, "no-store"),
                (header::CONTENT_TYPE, "application/json"),
            ],
            body,
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
    use sha2::{Digest, Sha256};
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
        let mut digest = Sha256::new();
        while let Some(chunk) = response.chunk().await.unwrap() {
            count += chunk.len();
            digest.update(&chunk);
        }
        assert_eq!(
            format!("{:x}", digest.finalize()),
            std::env::var("HTP_PROFILE_DETAIL_SHA").unwrap()
        );
        let minimum = std::env::var("HTP_PROFILE_MIN_DETAIL")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(30_000_000);
        assert!(count > minimum);
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
            (StatusCode::OK, "invalid", StatusCode::SERVICE_UNAVAILABLE),
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
    async fn detail_stream_propagates_truncation_and_classifies_split_null() {
        use futures_util::{StreamExt, stream};
        use std::io;
        for truncated in [false, true] {
            let rpc = Router::new().route(
                "/rest/v1/rpc/seosmith_audit_detail",
                post(move || async move {
                    let chunks: Vec<Result<&'static [u8], io::Error>> = if truncated {
                        vec![
                            Ok(b"{\"report\":"),
                            Err(io::Error::other("synthetic disconnect")),
                        ]
                    } else {
                        vec![Ok(b"  n"), Ok(b"u"), Ok(b"ll \n")]
                    };
                    Body::from_stream(stream::iter(chunks).then(|chunk| async move {
                        if chunk.is_err() {
                            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        }
                        chunk
                    }))
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let store = WebsiteStore::new(
                &format!("http://{}", listener.local_addr().unwrap()),
                "publishable",
            );
            let server = tokio::spawn(async move { axum::serve(listener, rpc).await.unwrap() });
            let response = read_router(store).oneshot(Request::builder()
                .uri("/websites/00000000-0000-0000-0000-000000000001/seo/audits/00000000-0000-0000-0000-000000000002")
                .header("authorization", "Bearer synthetic").body(Body::empty()).unwrap()).await.unwrap();
            if truncated {
                assert_eq!(response.status(), StatusCode::OK);
                assert!(to_bytes(response.into_body(), 4096).await.is_err());
            } else {
                assert_eq!(response.status(), StatusCode::NOT_FOUND);
            }
            server.abort();
        }
    }
    #[tokio::test]
    async fn detail_client_disconnect_cancels_upstream_stream() {
        use futures_util::stream;
        use std::{
            io,
            sync::{
                Arc, Mutex,
                atomic::{AtomicUsize, Ordering},
            },
            time::Duration,
        };
        struct OnDrop(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for OnDrop {
            fn drop(&mut self) {
                if let Some(tx) = self.0.take() {
                    let _ = tx.send(());
                }
            }
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        let tx = Arc::new(Mutex::new(Some(tx)));
        let count = Arc::new(AtomicUsize::new(0));
        let upstream_count = count.clone();
        let rpc = Router::new().route(
            "/rest/v1/rpc/seosmith_audit_detail",
            post(move || {
                let guard = OnDrop(tx.lock().unwrap().take());
                let upstream_count = upstream_count.clone();
                async move {
                    let chunk = axum::body::Bytes::from(vec![b' '; 64 * 1024]);
                    let prefix = axum::body::Bytes::from_static(b"{\"data\":\"");
                    Body::from_stream(stream::unfold(
                        (guard, chunk, Some(prefix), upstream_count),
                        |(guard, chunk, prefix, count)| async move {
                            let value = prefix.unwrap_or_else(|| chunk.clone());
                            count.fetch_add(1, Ordering::Relaxed);
                            Some((Ok::<_, io::Error>(value), (guard, chunk, None, count)))
                        },
                    ))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let store = WebsiteStore::new(
            &format!("http://{}", listener.local_addr().unwrap()),
            "publishable",
        );
        let server = tokio::spawn(async move { axum::serve(listener, rpc).await.unwrap() });
        let response = read_router(store).oneshot(Request::builder()
            .uri("/websites/00000000-0000-0000-0000-000000000001/seo/audits/00000000-0000-0000-0000-000000000002")
            .header("authorization", "Bearer synthetic").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            count.load(Ordering::Relaxed) < 512,
            "upstream was drained without a downstream consumer"
        );
        drop(response);
        tokio::time::timeout(Duration::from_secs(3), rx)
            .await
            .unwrap()
            .unwrap();
        server.abort();
    }
    #[tokio::test]
    #[ignore = "exercises the real ten-second upstream deadline"]
    async fn detail_stream_times_out_after_headers() {
        use futures_util::{StreamExt, stream};
        use std::{
            io,
            time::{Duration, Instant},
        };
        let rpc = Router::new().route(
            "/rest/v1/rpc/seosmith_audit_detail",
            post(|| async {
                Body::from_stream(
                    stream::iter(vec![Ok::<_, io::Error>(&b"{"[..]), Ok(&b"}"[..])])
                        .enumerate()
                        .then(|(index, item)| async move {
                            if index == 1 {
                                tokio::time::sleep(Duration::from_secs(12)).await;
                            }
                            item
                        }),
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let store = WebsiteStore::new(
            &format!("http://{}", listener.local_addr().unwrap()),
            "publishable",
        );
        let server = tokio::spawn(async move { axum::serve(listener, rpc).await.unwrap() });
        let started = Instant::now();
        let response = read_router(store).oneshot(Request::builder()
            .uri("/websites/00000000-0000-0000-0000-000000000001/seo/audits/00000000-0000-0000-0000-000000000002")
            .header("authorization", "Bearer synthetic").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(to_bytes(response.into_body(), 4096).await.is_err());
        assert!(
            started.elapsed() >= Duration::from_secs(9)
                && started.elapsed() < Duration::from_secs(12)
        );
        server.abort();
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
    async fn raw_input_limit_is_inclusive_for_worker_and_owner() {
        let rpc = Router::new()
            .route(
                "/rest/v1/rpc/ingest_seosmith_audit",
                post(|| async { Json(json!({"accepted":true})) }),
            )
            .route(
                "/rest/v1/rpc/import_seosmith_audit",
                post(|| async { Json(json!({"accepted":true})) }),
            )
            .layer(DefaultBodyLimit::max(32 * 1024 * 1024));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let store = WebsiteStore::new(
            &format!("http://{}", listener.local_addr().unwrap()),
            "publishable",
        );
        let server = tokio::spawn(async move { axum::serve(listener, rpc).await.unwrap() });
        let id = "00000000-0000-0000-0000-000000000001";
        for size in [4_952_756, 4_952_757] {
            for worker in [true, false] {
                let report = "x".repeat(size);
                let (app, uri, body) = if worker {
                    (
                        ingest_router(store.clone()),
                        "/integrations/seosmith/audits".to_string(),
                        json!({"delivery_id":id,"sha256":"a".repeat(64),"report_json":report}),
                    )
                } else {
                    (
                        read_router(store.clone()),
                        format!("/websites/{id}/seo/audits/import"),
                        json!({"report_json":report}),
                    )
                };
                let response = app
                    .oneshot(
                        Request::builder()
                            .method("POST")
                            .uri(uri)
                            .header("content-type", "application/json")
                            .header("authorization", format!("Bearer {}", "x".repeat(64)))
                            .header("idempotency-key", id)
                            .body(Body::from(body.to_string()))
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(
                    response.status(),
                    if size == 4_952_756 {
                        StatusCode::OK
                    } else {
                        StatusCode::PAYLOAD_TOO_LARGE
                    }
                );
                if size > 4_952_756 {
                    let body: serde_json::Value = serde_json::from_slice(
                        &to_bytes(response.into_body(), 4096).await.unwrap(),
                    )
                    .unwrap();
                    assert_eq!(body["error"], "report_limit");
                }
            }
        }
        server.abort();
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
    fn assert_traceparent(headers: &HeaderMap) {
        let value = headers["traceparent"].to_str().unwrap();
        let parts: Vec<_> = value.split('-').collect();
        assert_eq!(parts.len(), 4);
        assert_eq!(parts[0], "00");
        assert_eq!(parts[1].len(), 32);
        assert_ne!(parts[1], "11111111111111111111111111111111");
        assert!(uuid::Uuid::parse_str(parts[1]).is_ok());
        assert_eq!(parts[2].len(), 16);
        assert!(parts[2].bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(parts[2], "0000000000000000");
        assert_eq!(parts[3], "01");
        assert!(!headers.contains_key("x-htp-diagnostic-id"));
    }

    #[tokio::test]
    async fn valid_envelope_is_forwarded_to_only_the_credential_checked_rpc() {
        let id = "00000000-0000-0000-0000-000000000001";
        let rpc=Router::new().route("/rest/v1/rpc/ingest_seosmith_audit",post(|headers:HeaderMap,Json(body):Json<serde_json::Value>|async move {
            assert_eq!(headers["apikey"],"publishable");assert!(!headers.contains_key("authorization"));
            assert_traceparent(&headers);
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
                    .header("traceparent", "00-11111111111111111111111111111111-1111111111111111-01")
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
    async fn upstream_server_error_stays_sanitized_for_worker_and_owner() {
        let rpc = Router::new()
            .route(
                "/rest/v1/rpc/ingest_seosmith_audit",
                post(|headers: HeaderMap| async move {
                    assert_traceparent(&headers);
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({"code":"57014","message":"synthetic private detail"})),
                    )
                }),
            )
            .route(
                "/rest/v1/rpc/import_seosmith_audit",
                post(|headers: HeaderMap| async move {
                    assert_traceparent(&headers);
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({"code":"57014","message":"synthetic private detail"})),
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, rpc).await.unwrap() });
        let store = WebsiteStore::new(&url, "publishable");
        let id = "00000000-0000-0000-0000-000000000001";
        let worker = ingest_router(store.clone())
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
        let owner = read_router(store)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/websites/{id}/seo/audits/import"))
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer synthetic")
                    .body(Body::from(r#"{"report_json":"{}"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        for response in [worker, owner] {
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            let body = to_bytes(response.into_body(), 4096).await.unwrap();
            assert!(!String::from_utf8_lossy(&body).contains("private"));
            assert!(!String::from_utf8_lossy(&body).contains("57014"));
        }
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
