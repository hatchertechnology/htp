//! Owner-only read route for S14 wire-2 evidence families (WP8c-3).
//! The upstream is a fake `PostgREST` that stands in for migration 15's
//! `seosmith_audit_evidence_families` RPC (see coordination/tasks/w1c-8c2.md).
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    http::{HeaderMap, Request, StatusCode},
    routing::{get, post},
};
use htp_api::auth::SupabaseAuth;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode, get_current_timestamp};
use serde_json::{Value, json};
use tower::ServiceExt;

const WEBSITE: &str = "00000000-0000-0000-0000-000000000001";
const DELIVERY: &str = "00000000-0000-0000-0000-000000000002";
const PATH: &str = "/websites/00000000-0000-0000-0000-000000000001/seosmith/audits/00000000-0000-0000-0000-000000000002/evidence-families";

// Public test fixture only. This key is unrelated to any deployed project.
const TEST_KEY: &[u8] = b"-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgN259EDuuvQKvS3P1
X5TDF13Yw5yO5mxV69l/tGjWhV+hRANCAASZpPOvquuppgZnbUulhsGfVZYg3hNj
aKpDb+KKizP4pOlKiw3Ov4v43RK43imyuQMfaETyK/spnMZg78WYdE5w
-----END PRIVATE KEY-----";

/// What the fake RPC answers with.
#[derive(Clone)]
struct Upstream {
    status: StatusCode,
    body: &'static str,
}

struct Harness {
    app: Router,
    rpc_calls: Arc<AtomicUsize>,
    last_body: Arc<Mutex<Option<Value>>>,
    server: tokio::task::JoinHandle<()>,
    url: String,
}

impl Harness {
    async fn new(enabled: bool, upstream: Upstream) -> Self {
        let rpc_calls = Arc::new(AtomicUsize::new(0));
        let last_body = Arc::new(Mutex::new(None));
        let (calls, seen) = (rpc_calls.clone(), last_body.clone());
        let routes = Router::new()
            .route(
                "/auth/v1/.well-known/jwks.json",
                get(async || {
                    Json(json!({"keys": [{"alg": "ES256", "kty": "EC", "crv": "P-256", "use": "sig", "key_ops": ["verify"], "kid": "test-key", "x": "maTzr6rrqaYGZ21LpYbBn1WWIN4TY2iqQ2_iiosz-KQ", "y": "6UqLDc6_i_jdErjeKbK5Ax9oRPIr-ymcxmDvxZh0TnA"}]}))
                }),
            )
            .route(
                "/rest/v1/rpc/seosmith_audit_evidence_families",
                post(move |headers: HeaderMap, Json(body): Json<Value>| {
                    let (calls, seen, upstream) = (calls.clone(), seen.clone(), upstream.clone());
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(headers["apikey"], "publishable-fixture-key");
                        assert!(
                            headers["authorization"]
                                .to_str()
                                .unwrap()
                                .starts_with("Bearer ")
                        );
                        *seen.lock().unwrap() = Some(body);
                        (
                            upstream.status,
                            [("content-type", "application/json")],
                            upstream.body,
                        )
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, routes).await.unwrap() });
        let app = htp_api::app_with_capabilities(
            SupabaseAuth::new(&url),
            htp_api::websites::WebsiteStore::new(&url, "publishable-fixture-key"),
            htp_api::analytics::AnalyticsClient::new(&url),
            htp_api::RolloutCapabilities {
                evidence_families: enabled,
                ..Default::default()
            },
        );
        Self {
            app,
            rpc_calls,
            last_body,
            server,
            url,
        }
    }

    fn token(&self) -> String {
        self.token_for(false)
    }

    fn token_for(&self, anonymous: bool) -> String {
        let claims = json!({
            "iss": format!("{}/auth/v1", self.url),
            "aud": "authenticated",
            "sub": "a19a3adb-148d-4714-9278-c2d709fe0ad1",
            "exp": get_current_timestamp() + 3600,
            "role": "authenticated",
            "is_anonymous": anonymous
        });
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some("test-key".to_owned());
        encode(
            &header,
            &claims,
            &EncodingKey::from_ec_pem(TEST_KEY).unwrap(),
        )
        .unwrap()
    }

    async fn get(&self, path: &str, token: bool) -> axum::response::Response {
        let mut request = Request::get(path).header("host", "localhost");
        if token {
            request = request.header("authorization", format!("Bearer {}", self.token()));
        }
        self.send(request).await
    }

    async fn get_anonymous(&self, path: &str) -> axum::response::Response {
        let request = Request::get(path)
            .header("host", "localhost")
            .header("authorization", format!("Bearer {}", self.token_for(true)));
        self.send(request).await
    }

    async fn send(&self, request: axum::http::request::Builder) -> axum::response::Response {
        self.app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn json_body(response: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 1 << 20).await.unwrap()).unwrap()
}

const OWNER_V2: &str = r#"{"delivery_id":"00000000-0000-0000-0000-000000000002","wire_contract_version":"s14-wire-2","evidence_families":{"version":1,"semantics":"s14-families-1","families":{}},"reason":null}"#;
const OWNER_V1: &str = r#"{"delivery_id":"00000000-0000-0000-0000-000000000002","wire_contract_version":"s14-wire-1","evidence_families":null,"reason":"not_collected"}"#;

#[tokio::test]
async fn flag_off_makes_the_route_unavailable_without_touching_the_database() {
    let h = Harness::new(
        false,
        Upstream {
            status: StatusCode::OK,
            body: OWNER_V2,
        },
    )
    .await;
    let response = h.get(PATH, true).await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(h.rpc_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn owner_gets_the_families_object_with_no_store_cache() {
    let h = Harness::new(
        true,
        Upstream {
            status: StatusCode::OK,
            body: OWNER_V2,
        },
    )
    .await;
    let response = h.get(PATH, true).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body = json_body(response).await;
    assert_eq!(body, serde_json::from_str::<Value>(OWNER_V2).unwrap());
    assert_eq!(
        h.last_body.lock().unwrap().clone().unwrap(),
        json!({"p_website_id": WEBSITE, "p_delivery_id": DELIVERY})
    );
}

#[tokio::test]
async fn a_v1_audit_reports_not_collected_instead_of_an_error() {
    let h = Harness::new(
        true,
        Upstream {
            status: StatusCode::OK,
            body: OWNER_V1,
        },
    )
    .await;
    let response = h.get(PATH, true).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["reason"], "not_collected");
    assert!(body["evidence_families"].is_null());
}

#[tokio::test]
async fn a_nonowner_gets_404_not_403() {
    // The RPC raises `forbidden` (SQLSTATE 42501), which PostgREST serves as 403.
    let h = Harness::new(
        true,
        Upstream {
            status: StatusCode::FORBIDDEN,
            body: r#"{"code":"42501","message":"forbidden"}"#,
        },
    )
    .await;
    let response = h.get(PATH, true).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert!(
        !to_bytes(response.into_body(), 4096)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn an_unknown_delivery_gets_404() {
    let h = Harness::new(
        true,
        Upstream {
            status: StatusCode::OK,
            body: " null ",
        },
    )
    .await;
    assert_eq!(h.get(PATH, true).await.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn upstream_failures_are_unavailable_and_unauthenticated_is_401() {
    let h = Harness::new(
        true,
        Upstream {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            body: "{}",
        },
    )
    .await;
    assert_eq!(
        h.get(PATH, true).await.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    let before = h.rpc_calls.load(Ordering::SeqCst);
    assert_eq!(h.get(PATH, false).await.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(h.rpc_calls.load(Ordering::SeqCst), before);
}

#[tokio::test]
async fn malformed_ids_never_reach_the_database() {
    let h = Harness::new(
        true,
        Upstream {
            status: StatusCode::OK,
            body: OWNER_V2,
        },
    )
    .await;
    let path = format!("/websites/not-a-uuid/seosmith/audits/{DELIVERY}/evidence-families");
    assert_eq!(h.get(&path, true).await.status(), StatusCode::BAD_REQUEST);
    assert_eq!(h.rpc_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn the_rollout_flag_defaults_off() {
    assert!(!htp_api::RolloutCapabilities::default().evidence_families);
}

#[tokio::test]
async fn flag_off_answers_503_even_for_malformed_ids() {
    let h = Harness::new(
        false,
        Upstream {
            status: StatusCode::OK,
            body: OWNER_V2,
        },
    )
    .await;
    let path = format!("/websites/not-a-uuid/seosmith/audits/{DELIVERY}/evidence-families");
    assert_eq!(
        h.get(&path, true).await.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(h.rpc_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_non_object_success_body_is_unavailable() {
    for body in ["[]", "\"text\"", "7"] {
        let h = Harness::new(
            true,
            Upstream {
                status: StatusCode::OK,
                body,
            },
        )
        .await;
        assert_eq!(
            h.get(PATH, true).await.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "{body}"
        );
    }
}

#[tokio::test]
async fn an_anonymous_session_is_401_without_a_database_call() {
    let h = Harness::new(
        true,
        Upstream {
            status: StatusCode::OK,
            body: OWNER_V2,
        },
    )
    .await;
    assert_eq!(
        h.get_anonymous(PATH).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(h.rpc_calls.load(Ordering::SeqCst), 0);
}

const OWNER_SIX_FAMILIES: &str = r#"{"delivery_id":"00000000-0000-0000-0000-000000000002","wire_contract_version":"s14-wire-2","evidence_families":{"version":1,"semantics":"s14-families-1","families":{"s01_discovery":{"state":"collected"},"s02_content":{"state":"unavailable"},"s03_integrity":{"state":"collected"},"s04_links":{"state":"unknown"},"s05_structure":{"state":"collected"},"s06_policy":{"state":"unavailable"}}},"reason":null}"#;

#[tokio::test]
async fn a_six_family_owner_object_is_relayed_unchanged() {
    let h = Harness::new(
        true,
        Upstream {
            status: StatusCode::OK,
            body: OWNER_SIX_FAMILIES,
        },
    )
    .await;
    let response = h.get(PATH, true).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    let families = body["evidence_families"]["families"].as_object().unwrap();
    assert_eq!(families.len(), 6);
    assert_eq!(
        body,
        serde_json::from_str::<Value>(OWNER_SIX_FAMILIES).unwrap()
    );
}
