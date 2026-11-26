use super::*;
use axum::{body::Body, http::Request as HttpRequest};
use futures_util::stream;
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tower::ServiceExt;

const FIXTURE: &[u8] = include_bytes!(
    "../../../../crates/s14-receiver/tests/fixtures/s14-finding-coverage-v1/complete-missing-h1.json"
);
const SERVICE_KEY: &str = "service-key-never-on-legacy-routes";
const TOKEN: &str = "Bearer xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

#[derive(Clone)]
struct Upstream {
    calls: Arc<Mutex<Vec<(HeaderMap, Value)>>>,
    reply: Arc<Mutex<(u16, Value)>>,
    /// Token lookups (`seosmith_bindings`): headers and raw query.
    lookups: Arc<Mutex<Vec<(HeaderMap, String)>>>,
    binding: Arc<Mutex<(u16, Value)>>,
}

impl Upstream {
    fn replying(status: u16, body: Value) -> Self {
        Self {
            calls: Arc::default(),
            reply: Arc::new(Mutex::new((status, body))),
            lookups: Arc::default(),
            binding: Arc::new(Mutex::new((200, json!([{"website_id": Uuid::nil()}])))),
        }
    }
    fn binding_replies(&self, status: u16, body: Value) {
        *self.binding.lock().unwrap() = (status, body);
    }
    async fn serve(&self) -> String {
        let me = self.clone();
        let lookup = self.clone();
        let app = Router::new()
            .route(
                "/rest/v1/rpc/{name}",
                post(move |headers: HeaderMap, Json(body): Json<Value>| {
                    let me = me.clone();
                    async move {
                        me.calls.lock().unwrap().push((headers, body));
                        let (status, body) = me.reply.lock().unwrap().clone();
                        (StatusCode::from_u16(status).unwrap(), Json(body))
                    }
                }),
            )
            .route(
                "/rest/v1/seosmith_bindings",
                axum::routing::get(
                    move |headers: HeaderMap, axum::extract::RawQuery(query): axum::extract::RawQuery| {
                        let me = lookup.clone();
                        async move {
                            me.lookups
                                .lock()
                                .unwrap()
                                .push((headers, query.unwrap_or_default()));
                            let (status, body) = me.binding.lock().unwrap().clone();
                            (StatusCode::from_u16(status).unwrap(), Json(body))
                        }
                    },
                ),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        url
    }
    fn count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

fn receipt(id: Uuid, sha: &str) -> Value {
    json!({"delivery_id": id, "sha256": sha, "accepted": true})
}

fn state(url: &str) -> State14 {
    State14 {
        store: WebsiteStore::new(url, "publishable"),
        service_key: Some(SERVICE_KEY.into()),
        intake: Arc::new(Semaphore::new(1)),
        request_budget: Duration::from_secs(120),
        body_deadline: Duration::from_secs(60),
        permit: Arc::new(Semaphore::new(1)),
        validate: admit,
        admit_deadline: Duration::from_secs(30),
        outer_timeout: Duration::from_secs(30),
    }
}

fn envelope(report: &[u8]) -> (Uuid, String, Vec<u8>) {
    let id = Uuid::new_v4();
    let sha = hex_sha256(report);
    let body = serde_json::to_vec(&json!({
        "delivery_id": id,
        "sha256": sha,
        "report_json": std::str::from_utf8(report).unwrap(),
    }))
    .unwrap();
    (id, sha, body)
}

fn post_request(id: Uuid, body: Vec<u8>) -> HttpRequest<Body> {
    HttpRequest::builder()
        .method("POST")
        .uri(PATH)
        .header("content-type", "application/json")
        .header("authorization", TOKEN)
        .header("idempotency-key", id.to_string())
        .body(Body::from(body))
        .unwrap()
}

async fn status_and_body(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn without_a_finding() -> Vec<u8> {
    let mut report: Value = serde_json::from_slice(FIXTURE).unwrap();
    report["findings"].as_array_mut().unwrap().pop().unwrap();
    serde_json::to_vec(&report).unwrap()
}

#[test]
fn fixture_admits_under_the_real_validator() {
    admit(FIXTURE, Instant::now() + Duration::from_secs(30)).expect("fixture admits");
}

#[tokio::test]
async fn gate_off_is_503_without_polling_the_body() {
    let polls = Arc::new(AtomicUsize::new(0));
    let observed = polls.clone();
    let body = Body::from_stream(stream::poll_fn(move |_| {
        observed.fetch_add(1, Ordering::SeqCst);
        std::task::Poll::Ready(Some(Err::<axum::body::Bytes, _>(std::io::Error::other(
            "body must not be read",
        ))))
    }));
    let mut closed = state("http://127.0.0.1:1");
    closed.service_key = None;
    let response = router_with(closed)
        .oneshot(
            HttpRequest::builder()
                .method("POST")
                .uri(PATH)
                .header("content-length", "33554432")
                .header("authorization", TOKEN)
                .body(body)
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, body) = status_and_body(response).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"], "policy_receiver_unavailable");
    assert_eq!(polls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn default_app_is_closed_unless_the_gate_is_exactly_true() {
    // No gate or key in the test environment's router config: the real wiring
    // (`router` reads the environment) must not open by default.
    let app = crate::app_with_services(
        crate::auth::SupabaseAuth::new("http://127.0.0.1:1"),
        WebsiteStore::new("http://127.0.0.1:1", "synthetic"),
    );
    let response = app
        .oneshot(post_request(Uuid::new_v4(), b"{}".to_vec()))
        .await
        .unwrap();
    let (status, body) = status_and_body(response).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"], "policy_receiver_unavailable");
}

#[tokio::test]
async fn no_other_method_can_open_the_worker_path() {
    let response = router_with(state("http://127.0.0.1:1"))
        .oneshot(
            HttpRequest::builder()
                .uri(PATH)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test]
async fn valid_report_makes_one_rpc_call_and_passes_the_receipt_through() {
    let (id, sha, body) = envelope(FIXTURE);
    let upstream = Upstream::replying(200, receipt(id, &sha));
    let url = upstream.serve().await;
    let response = router_with(state(&url))
        .oneshot(post_request(id, body))
        .await
        .unwrap();
    let (status, body) = status_and_body(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, receipt(id, &sha));
    assert_eq!(upstream.count(), 1);
    let (headers, sent) = upstream.calls.lock().unwrap()[0].clone();
    assert_eq!(headers["apikey"], SERVICE_KEY);
    assert_eq!(headers["authorization"], format!("Bearer {SERVICE_KEY}"));
    assert_eq!(sent["p_token"], TOKEN.strip_prefix("Bearer ").unwrap());
    assert_eq!(sent["p_delivery_id"], id.to_string());
    assert_eq!(sent["p_sha256"], sha);
    assert_eq!(sent["p_report_json"].as_str().unwrap().as_bytes(), FIXTURE);
    assert_eq!(sent["p_validator_revision"], VALIDATOR_REVISION);
    let admitted = admit(FIXTURE, Instant::now() + Duration::from_secs(30)).unwrap();
    assert_eq!(
        sent["p_summary_text"].as_str().unwrap().as_bytes(),
        admitted.summary.canonical
    );
    let mut keys: Vec<_> = sent.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "p_delivery_id",
            "p_report_json",
            "p_sha256",
            "p_summary_text",
            "p_token",
            "p_validator_revision"
        ]
    );
}

#[tokio::test]
async fn admission_failure_is_422_without_any_rpc_call() {
    let report = without_a_finding();
    let (id, _, body) = envelope(&report);
    let upstream = Upstream::replying(200, json!({}));
    let url = upstream.serve().await;
    let response = router_with(state(&url))
        .oneshot(post_request(id, body))
        .await
        .unwrap();
    let (status, body) = status_and_body(response).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["error"], "semantic_mismatch");
    assert!(["inspection", "summary", "population"].contains(&body["stage"].as_str().unwrap()));
    assert_eq!(upstream.count(), 0);
}

#[tokio::test]
async fn a_committed_retry_is_still_admitted_before_the_rpc() {
    // The API is the semantic validator: even a retry of a committed delivery
    // is checked first, so a corrupted retry never reaches the database.
    let report = without_a_finding();
    let (id, sha, body) = envelope(&report);
    let upstream = Upstream::replying(200, receipt(id, &sha));
    let url = upstream.serve().await;
    let response = router_with(state(&url))
        .oneshot(post_request(id, body))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(upstream.count(), 0);
}

#[tokio::test]
async fn oversize_reports_and_envelopes_are_413_without_an_rpc_call() {
    let upstream = Upstream::replying(200, json!({}));
    let url = upstream.serve().await;
    let app = router_with(state(&url));
    // Report over the 4,952,756-byte cap, inside a valid envelope.
    let big = vec![b' '; MAX_REPORT_BYTES + 1];
    let (id, _, body) = envelope(&big);
    let response = app.clone().oneshot(post_request(id, body)).await.unwrap();
    let (status, body) = status_and_body(response).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body["error"], "report_limit");
    // Declared envelope over 32 MiB.
    let mut request = post_request(Uuid::new_v4(), Vec::new());
    request.headers_mut().insert(
        "content-length",
        (ENVELOPE_LIMIT + 1).to_string().parse().unwrap(),
    );
    assert_eq!(
        app.clone().oneshot(request).await.unwrap().status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    // Undeclared (chunked) body over 32 MiB.
    let chunk = axum::body::Bytes::from(vec![b'a'; 1 << 20]);
    let streamed = Body::from_stream(stream::iter(
        (0..34).map(move |_| Ok::<_, std::io::Error>(chunk.clone())),
    ));
    let mut request = post_request(Uuid::new_v4(), Vec::new());
    *request.body_mut() = streamed;
    assert_eq!(
        app.oneshot(request).await.unwrap().status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(upstream.count(), 0);
}

#[tokio::test]
async fn bad_token_and_bad_envelopes_are_rejected_before_validation() {
    let upstream = Upstream::replying(200, json!({}));
    let url = upstream.serve().await;
    let app = router_with(state(&url));
    let (id, sha, body) = envelope(FIXTURE);
    let mut no_token = post_request(id, body.clone());
    no_token.headers_mut().remove("authorization");
    assert_eq!(
        app.clone().oneshot(no_token).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let mut short = post_request(id, body.clone());
    short
        .headers_mut()
        .insert("authorization", "Bearer short".parse().unwrap());
    assert_eq!(
        app.clone().oneshot(short).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let wrong_key = post_request(Uuid::new_v4(), body);
    assert_eq!(
        app.clone().oneshot(wrong_key).await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    let unknown_field = serde_json::to_vec(
        &json!({"delivery_id": id, "sha256": sha, "report_json": "{}", "extra": 1}),
    )
    .unwrap();
    assert_eq!(
        app.clone()
            .oneshot(post_request(id, unknown_field))
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    let wrong_sha = serde_json::to_vec(
        &json!({"delivery_id": id, "sha256": "0".repeat(64), "report_json": "{}"}),
    )
    .unwrap();
    assert_eq!(
        app.oneshot(post_request(id, wrong_sha))
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(upstream.count(), 0);
}

fn slow_validator(_: &[u8], _: Instant) -> Result<Admitted, AdmissionError> {
    std::thread::sleep(Duration::from_millis(700));
    Err(AdmissionError {
        stage: htp_s14_receiver::AdmissionStage::Inspection,
        error: InspectionError::Shape,
    })
}

#[tokio::test]
async fn concurrent_request_gets_429_while_validation_runs() {
    let (id, _, body) = envelope(FIXTURE);
    let upstream = Upstream::replying(200, json!({}));
    let url = upstream.serve().await;
    let mut slow = state(&url);
    slow.validate = slow_validator;
    let app = router_with(slow);
    let first = tokio::spawn(app.clone().oneshot(post_request(id, body.clone())));
    tokio::time::sleep(Duration::from_millis(150)).await;
    let response = app.oneshot(post_request(id, body)).await.unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response.headers()[header::RETRY_AFTER], "5");
    assert_eq!(
        first.await.unwrap().unwrap().status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

#[tokio::test]
async fn outer_timeout_keeps_the_permit_until_the_closure_ends() {
    let (id, sha, body) = envelope(FIXTURE);
    let upstream = Upstream::replying(200, receipt(id, &sha));
    let url = upstream.serve().await;
    let mut slow = state(&url);
    slow.validate = slow_validator;
    slow.outer_timeout = Duration::from_millis(100);
    let app = router_with(slow);
    let timed_out = app
        .clone()
        .oneshot(post_request(id, body.clone()))
        .await
        .unwrap();
    let (status, json_body) = status_and_body(timed_out).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(json_body["error"], "validation_unavailable");
    // The request returned, the closure is still running: busy, not a free slot.
    let second = app
        .clone()
        .oneshot(post_request(id, body.clone()))
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::TOO_MANY_REQUESTS);
    tokio::time::sleep(Duration::from_millis(800)).await;
    let third = app.oneshot(post_request(id, body)).await.unwrap();
    // A free slot: the slow validator runs again and times out again (not busy).
    let (status, json_body) = status_and_body(third).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(json_body["error"], "validation_unavailable");
    assert_eq!(upstream.count(), 0);
}

#[tokio::test]
async fn expired_receiver_deadline_is_retryable_not_a_verdict() {
    let (id, _, body) = envelope(FIXTURE);
    let upstream = Upstream::replying(200, json!({}));
    let url = upstream.serve().await;
    let mut expired = state(&url);
    expired.admit_deadline = Duration::ZERO;
    let response = router_with(expired)
        .oneshot(post_request(id, body))
        .await
        .unwrap();
    let (status, body) = status_and_body(response).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"], "validation_unavailable");
}

async fn database_says(status: u16, message: &str, code: &str) -> (StatusCode, Value) {
    let (id, _, body) = envelope(FIXTURE);
    let upstream = Upstream::replying(status, json!({"code": code, "message": message}));
    let url = upstream.serve().await;
    let response = router_with(state(&url))
        .oneshot(post_request(id, body))
        .await
        .unwrap();
    assert_eq!(upstream.count(), 1);
    status_and_body(response).await
}

#[tokio::test]
async fn database_errors_follow_the_h2_contract() {
    let cases = [
        (409, "delivery_conflict", "23505", 409, "delivery_conflict"),
        (403, "invalid_worker", "42501", 403, "invalid_worker"),
        (
            503,
            "validator_disabled",
            "55000",
            503,
            "validator_disabled",
        ),
        (400, "report_limit", "22023", 413, "report_limit"),
        (400, "invalid_delivery", "22023", 400, "invalid_delivery"),
        (
            400,
            "invalid_binding_or_report",
            "22023",
            400,
            "invalid_delivery",
        ),
        (400, "evidence_invalid", "22023", 422, "evidence_invalid"),
        (
            400,
            "invalid_s14_binding",
            "22023",
            422,
            "semantic_mismatch",
        ),
        (
            400,
            "invalid_s14_summary",
            "22023",
            422,
            "semantic_mismatch",
        ),
        // Operational faults are retryable, never terminal or a worker verdict.
        (
            403,
            "permission denied for function commit_seosmith_audit_v4",
            "42501",
            503,
            "unavailable",
        ),
        (500, "s14_schema4_rows_exist", "55000", 503, "unavailable"),
        (
            500,
            "canceling statement due to statement timeout",
            "57014",
            503,
            "unavailable",
        ),
    ];
    for (upstream_status, message, code, want, name) in cases {
        let (status, body) = database_says(upstream_status, message, code).await;
        assert_eq!(
            (status.as_u16(), body["error"].as_str().unwrap()),
            (want, name),
            "{message}"
        );
    }
}

#[tokio::test]
async fn evidence_invalid_carries_only_a_sanitised_detail() {
    let (id, _, body) = envelope(FIXTURE);
    let upstream = Upstream::replying(
        400,
        json!({"code":"22023","message":"evidence_invalid","details":"invalid_evidence_pointer"}),
    );
    let url = upstream.serve().await;
    let response = router_with(state(&url))
        .oneshot(post_request(id, body.clone()))
        .await
        .unwrap();
    let (status, body_json) = status_and_body(response).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body_json["detail"], "invalid_evidence_pointer");
    *upstream.reply.lock().unwrap() = (
        400,
        json!({"code":"22023","message":"evidence_invalid","details":"secret row: 123"}),
    );
    let response = router_with(state(&url))
        .oneshot(post_request(id, body))
        .await
        .unwrap();
    let (_, body_json) = status_and_body(response).await;
    assert_eq!(body_json["detail"], Value::Null);
}

#[tokio::test]
async fn a_disabled_revision_blocks_new_rows_but_a_committed_retry_gets_its_receipt() {
    let (disabled_status, disabled) = database_says(503, "validator_disabled", "55000").await;
    assert_eq!(disabled_status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(disabled["error"], "validator_disabled");
    // The database returns the original receipt for a committed identical delivery.
    let (id, sha, body) = envelope(FIXTURE);
    let upstream = Upstream::replying(200, receipt(id, &sha));
    let url = upstream.serve().await;
    let response = router_with(state(&url))
        .oneshot(post_request(id, body))
        .await
        .unwrap();
    let (status, body) = status_and_body(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["accepted"], true);
}

#[tokio::test]
async fn a_receipt_for_another_delivery_is_not_passed_through() {
    let (id, _, body) = envelope(FIXTURE);
    let upstream = Upstream::replying(200, receipt(Uuid::new_v4(), &"0".repeat(64)));
    let url = upstream.serve().await;
    let response = router_with(state(&url))
        .oneshot(post_request(id, body))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn the_service_key_is_never_sent_on_the_legacy_route() {
    let upstream = Upstream::replying(200, json!({"accepted": true}));
    let url = upstream.serve().await;
    let (id, _, body) = envelope(FIXTURE);
    let mut request = post_request(id, body);
    *request.uri_mut() = "/integrations/seosmith/audits".parse().unwrap();
    // SAFETY-free: the process environment is not consulted by the legacy route.
    let app = crate::seosmith::ingest_router(WebsiteStore::new(&url, "publishable"));
    let _ = app.oneshot(request).await.unwrap();
    let calls = upstream.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    let (headers, sent) = &calls[0];
    for (_, value) in headers {
        assert!(!value.to_str().unwrap_or_default().contains(SERVICE_KEY));
    }
    assert_eq!(headers["apikey"], "publishable");
    assert!(!sent.to_string().contains(SERVICE_KEY));
    assert_eq!(sent.as_object().unwrap().get("p_validator_revision"), None);
}

#[test]
fn the_validator_revision_is_the_h1_constant() {
    assert_eq!(
        VALIDATOR_REVISION,
        "s14-wire-1/full-population-1/evidence-v1"
    );
}

fn cgroup_peak_bytes() -> Option<u64> {
    let own = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    let path = own.lines().find_map(|l| l.strip_prefix("0::"))?;
    std::fs::read_to_string(format!("/sys/fs/cgroup{path}/memory.peak"))
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// M9: one request through the route, then the cgroup's `memory.peak`. Run it
/// under `systemd-run --user --scope -p MemoryMax=256M`. `S14_M9_REPORT` names
/// the report; `S14_M9_ESCAPED=1` instead builds the worst-case JSON-escaped
/// envelope (every report byte as `\u0001`, the largest legal escape).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "M9 resource measurement; needs S14_M9_REPORT and a cgroup scope"]
async fn m9_envelope_through_the_route() {
    let started = Instant::now();
    let report = std::fs::read(std::env::var("S14_M9_REPORT").unwrap()).unwrap();
    let (id, sha, body) = if std::env::var("S14_M9_ESCAPED").is_ok() {
        let raw = "\u{1}".repeat(MAX_REPORT_BYTES);
        let sha = hex_sha256(raw.as_bytes());
        let id = Uuid::new_v4();
        let body =
            serde_json::to_vec(&json!({"delivery_id": id, "sha256": sha, "report_json": raw}))
                .unwrap();
        (id, sha, body)
    } else {
        envelope(&report)
    };
    let envelope_bytes = body.len();
    let upstream = Upstream::replying(200, receipt(id, &sha));
    let url = upstream.serve().await;
    let mut live = state(&url);
    live.admit_deadline = Duration::from_secs(15);
    live.outer_timeout = Duration::from_secs(25);
    let response = router_with(live)
        .oneshot(post_request(id, body))
        .await
        .unwrap();
    let (status, body) = status_and_body(response).await;
    println!(
        "M9 envelope_bytes={envelope_bytes} report_bytes={} status={status} body={body} rpc_calls={} elapsed_ms={} cgroup_peak_kib={}",
        report.len(),
        upstream.count(),
        started.elapsed().as_millis(),
        cgroup_peak_bytes().map_or(-1, |b| i128::from(b) / 1024),
    );
}

#[test]
fn the_gate_predicate_opens_only_for_exactly_true_with_a_key() {
    assert_eq!(
        service_key_for(Some("true"), Some("k")),
        Some("k".to_owned())
    );
    for gate in [
        None,
        Some(""),
        Some("false"),
        Some("TRUE"),
        Some("1"),
        Some("true "),
    ] {
        assert_eq!(service_key_for(gate, Some("k")), None, "gate {gate:?}");
    }
    assert_eq!(service_key_for(Some("true"), None), None);
    assert_eq!(service_key_for(Some("true"), Some("")), None);
}

#[tokio::test]
async fn a_gate_that_resolves_closed_never_polls_the_body_end_to_end() {
    let polls = Arc::new(AtomicUsize::new(0));
    let observed = polls.clone();
    let body = Body::from_stream(stream::poll_fn(move |_| {
        observed.fetch_add(1, Ordering::SeqCst);
        std::task::Poll::Ready(Some(Err::<axum::body::Bytes, _>(std::io::Error::other(
            "body must not be read",
        ))))
    }));
    let mut closed = state("http://127.0.0.1:1");
    closed.service_key = service_key_for(Some("TRUE"), Some(SERVICE_KEY));
    let mut request = post_request(Uuid::new_v4(), Vec::new());
    *request.body_mut() = body;
    let response = router_with(closed).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(polls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_gate_that_resolves_open_serves_the_route() {
    let (id, sha, body) = envelope(FIXTURE);
    let upstream = Upstream::replying(200, receipt(id, &sha));
    let url = upstream.serve().await;
    let mut open = state(&url);
    open.service_key = service_key_for(Some("true"), Some(SERVICE_KEY));
    let response = router_with(open)
        .oneshot(post_request(id, body))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(upstream.count(), 1);
}

#[tokio::test]
async fn exactly_at_the_report_cap_is_not_413() {
    let upstream = Upstream::replying(200, json!({}));
    let url = upstream.serve().await;
    let exact = vec![b' '; MAX_REPORT_BYTES];
    let (id, _, body) = envelope(&exact);
    let response = router_with(state(&url))
        .oneshot(post_request(id, body))
        .await
        .unwrap();
    let (status, body) = status_and_body(response).await;
    // Past the byte cap check, so the receiver judges it (not admissible).
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["error"], "semantic_mismatch");
    assert_eq!(upstream.count(), 0);
}

static VALIDATIONS: AtomicUsize = AtomicUsize::new(0);
fn counting(_: &[u8], _: Instant) -> Result<Admitted, AdmissionError> {
    VALIDATIONS.fetch_add(1, Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(500));
    Err(AdmissionError {
        stage: htp_s14_receiver::AdmissionStage::Inspection,
        error: InspectionError::Shape,
    })
}

#[tokio::test]
async fn an_unknown_token_is_403_before_admit_and_holds_no_permit() {
    let upstream = Upstream::replying(200, json!({}));
    upstream.binding_replies(200, json!([]));
    let url = upstream.serve().await;
    let (id, _, body) = envelope(FIXTURE);
    let mut known = state(&url);
    known.validate = counting;
    let app = router_with(known);
    let response = app
        .clone()
        .oneshot(post_request(id, body.clone()))
        .await
        .unwrap();
    let (status, json_body) = status_and_body(response).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(json_body["error"], "invalid_worker");
    assert_eq!(VALIDATIONS.load(Ordering::SeqCst), 0);
    assert_eq!(upstream.count(), 0);
    // The lookup is by token digest, with the service key, and nothing else.
    {
        let lookups = upstream.lookups.lock().unwrap();
        assert_eq!(lookups.len(), 1);
        assert!(lookups[0].1.contains(&format!(
            "token_sha256=eq.{}",
            hex_sha256(TOKEN.trim_start_matches("Bearer ").as_bytes())
        )));
        assert_eq!(lookups[0].0["apikey"], SERVICE_KEY);
        assert!(!lookups[0].1.contains("xxxxxxxx"));
    }
    // With the validation slot busy, a bogus token still gets its 403, not 429.
    upstream.binding_replies(200, json!([{"website_id": Uuid::nil()}]));
    let busy_run = tokio::spawn(app.clone().oneshot(post_request(id, body.clone())));
    tokio::time::sleep(Duration::from_millis(150)).await;
    upstream.binding_replies(200, json!([]));
    let bogus = app.clone().oneshot(post_request(id, body)).await.unwrap();
    assert_eq!(bogus.status(), StatusCode::FORBIDDEN);
    busy_run.await.unwrap().unwrap();
}

#[tokio::test]
async fn a_failing_token_lookup_is_retryable_not_a_verdict() {
    let upstream = Upstream::replying(200, json!({}));
    upstream.binding_replies(500, json!({"message": "boom"}));
    let url = upstream.serve().await;
    let (id, _, body) = envelope(FIXTURE);
    let response = router_with(state(&url))
        .oneshot(post_request(id, body))
        .await
        .unwrap();
    let (status, json_body) = status_and_body(response).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(json_body["error"], "unavailable");
    assert_eq!(upstream.count(), 0);
}

#[tokio::test]
async fn a_busy_intake_is_503_at_once_and_the_body_is_not_polled() {
    let upstream = Upstream::replying(200, json!({}));
    let url = upstream.serve().await;
    let held = state(&url);
    let _slot = held.intake.clone().try_acquire_owned().unwrap();
    let polls = Arc::new(AtomicUsize::new(0));
    let observed = polls.clone();
    let mut request = post_request(Uuid::new_v4(), Vec::new());
    *request.body_mut() = Body::from_stream(stream::poll_fn(move |_| {
        observed.fetch_add(1, Ordering::SeqCst);
        std::task::Poll::Ready(Some(Err::<axum::body::Bytes, _>(std::io::Error::other(
            "body must not be read",
        ))))
    }));
    let response = router_with(held).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers()[header::RETRY_AFTER], "5");
    assert_eq!(polls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn the_intake_slot_is_free_again_after_a_request() {
    let (id, sha, body) = envelope(FIXTURE);
    let upstream = Upstream::replying(200, receipt(id, &sha));
    let url = upstream.serve().await;
    let app = router_with(state(&url));
    for _ in 0..2 {
        let response = app
            .clone()
            .oneshot(post_request(id, body.clone()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}

#[tokio::test]
async fn a_stalled_body_times_out_and_the_budget_caps_it() {
    let upstream = Upstream::replying(200, json!({}));
    let url = upstream.serve().await;
    for (body_deadline, budget) in [
        (Duration::from_millis(100), Duration::from_secs(120)),
        (Duration::from_secs(60), Duration::from_millis(100)),
    ] {
        let mut slow = state(&url);
        slow.body_deadline = body_deadline;
        slow.request_budget = budget;
        let mut request = post_request(Uuid::new_v4(), Vec::new());
        *request.body_mut() =
            Body::from_stream(stream::pending::<Result<axum::body::Bytes, std::io::Error>>());
        let started = Instant::now();
        let response = router_with(slow).oneshot(request).await.unwrap();
        let (status, body) = status_and_body(response).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["error"], "body_timeout");
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}

#[tokio::test]
async fn the_receipt_is_rebuilt_from_validated_fields_only() {
    let (id, sha, body) = envelope(FIXTURE);
    let mut upstream_receipt = receipt(id, &sha);
    upstream_receipt["internal"] = json!("must not leak");
    let upstream = Upstream::replying(200, upstream_receipt);
    let url = upstream.serve().await;
    let response = router_with(state(&url))
        .oneshot(post_request(id, body))
        .await
        .unwrap();
    let (status, json_body) = status_and_body(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json_body, receipt(id, &sha));
}
