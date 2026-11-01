use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
    routing::get,
};
use htp_api::auth::SupabaseAuth;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode, get_current_timestamp};
use serde_json::{Value, json};
use tower::ServiceExt;

// Public test fixture only. This key is unrelated to any deployed project.
const TEST_KEY: &[u8] = b"-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgN259EDuuvQKvS3P1
X5TDF13Yw5yO5mxV69l/tGjWhV+hRANCAASZpPOvquuppgZnbUulhsGfVZYg3hNj
aKpDb+KKizP4pOlKiw3Ov4v43RK43imyuQMfaETyK/spnMZg78WYdE5w
-----END PRIVATE KEY-----";

struct TestAuth {
    url: String,
    app: Router,
    requests: Arc<AtomicUsize>,
    server: tokio::task::JoinHandle<()>,
}

impl TestAuth {
    async fn new() -> Self {
        Self::with_routes(Router::new()).await
    }

    async fn with_routes(routes: Router) -> Self {
        let requests = Arc::new(AtomicUsize::new(0));
        let hits = requests.clone();
        let jwks = Router::new().route("/auth/v1/.well-known/jwks.json", get(async move || {
            hits.fetch_add(1, Ordering::SeqCst);
            Json(json!({"keys": [{"alg": "ES256", "kty": "EC", "crv": "P-256", "use": "sig", "key_ops": ["verify"], "kid": "test-key", "x": "maTzr6rrqaYGZ21LpYbBn1WWIN4TY2iqQ2_iiosz-KQ", "y": "6UqLDc6_i_jdErjeKbK5Ax9oRPIr-ymcxmDvxZh0TnA"}]}))
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, jwks.merge(routes)).await.unwrap();
        });
        let app = htp_api::app_with_analytics(
            SupabaseAuth::new(&url),
            htp_api::websites::WebsiteStore::new(&url, "publishable-fixture-key"),
            htp_api::analytics::AnalyticsClient::new(&url),
        );
        Self {
            url,
            app,
            requests,
            server,
        }
    }

    fn claims(&self) -> Value {
        json!({
            "iss": format!("{}/auth/v1", self.url),
            "aud": "authenticated",
            "sub": "a19a3adb-148d-4714-9278-c2d709fe0ad1",
            "exp": get_current_timestamp() + 3600,
            "role": "authenticated",
            "is_anonymous": false
        })
    }

    fn token(claims: &Value, kid: &str) -> String {
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some(kid.to_owned());
        encode(
            &header,
            claims,
            &EncodingKey::from_ec_pem(TEST_KEY).unwrap(),
        )
        .unwrap()
    }

    async fn request(&self, path: &str, token: Option<&str>) -> axum::response::Response {
        let mut request = if path == "/secured" {
            Request::get(path)
        } else {
            Request::post(path)
        }
        .header("host", "localhost")
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", "2025-11-25");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        self.app
            .clone()
            .oneshot(
                request
                    .body(Body::from(
                        json!({
                            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                            "params": {"name": "hello_world_secured", "arguments": {}}
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap()
    }
}

impl Drop for TestAuth {
    fn drop(&mut self) {
        self.server.abort();
    }
}

#[tokio::test]
async fn official_mcp_client_authenticates_every_request() {
    use rmcp::{
        ServiceExt as _,
        model::{CallToolRequestParams, ClientConfig},
        transport::{
            StreamableHttpClientTransport,
            streamable_http_client::StreamableHttpClientTransportConfig,
        },
    };

    let auth = TestAuth::new().await;
    let token = TestAuth::token(&auth.claims(), "test-key");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/mcp/secured", listener.local_addr().unwrap());
    let app = auth.app.clone();
    let server = tokio::spawn(async move { axum::serve(listener, app).await });

    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let transport = StreamableHttpClientTransport::with_client(
            reqwest::Client::new(),
            StreamableHttpClientTransportConfig::with_uri(endpoint).auth_header(token),
        );
        let client = ClientConfig::default().serve(transport).await.unwrap();
        let tools = client.list_tools(None).await.unwrap();
        assert_eq!(tools.tools.len(), 18);
        assert!(tools.tools.iter().any(|tool| tool.name == "create_website"));
        let result = client
            .call_tool(CallToolRequestParams::new("hello_world_secured"))
            .await
            .unwrap();
        assert_eq!(
            result.structured_content,
            Some(json!({"message": "hello world secured"}))
        );
        client.cancel().await.unwrap();
    })
    .await
    .expect("Protected MCP lifecycle timed out");
    server.abort();
}

#[tokio::test]
async fn valid_signed_user_tokens_access_both_secured_endpoints() {
    let auth = TestAuth::new().await;
    let token = TestAuth::token(&auth.claims(), "test-key");
    for path in ["/secured", "/mcp/secured"] {
        let response = auth.request(path, Some(&token)).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        if path == "/secured" {
            assert_eq!(body, json!({"message": "hello world secured"}));
        } else {
            assert_eq!(
                body["result"]["structuredContent"],
                json!({"message": "hello world secured"})
            );
        }
    }
    assert_eq!(
        auth.requests.load(Ordering::SeqCst),
        1,
        "JWKS must be cached"
    );
}

#[tokio::test]
async fn missing_and_malformed_tokens_never_reach_the_auth_provider() {
    let auth = TestAuth::new().await;
    for path in ["/secured", "/mcp/secured"] {
        for token in [None, Some(""), Some("not-a-jwt")] {
            let response = auth.request(path, token).await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            assert!(response.headers().contains_key("www-authenticate"));
        }
    }
    assert_eq!(auth.requests.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn rejects_expired_wrong_project_wrong_audience_and_non_user_tokens() {
    let auth = TestAuth::new().await;
    for (field, value) in [
        ("exp", json!(1)),
        ("iss", json!("https://other.supabase.co/auth/v1")),
        ("aud", json!("other-app")),
        ("role", json!("anon")),
        ("role", json!("service_role")),
        ("is_anonymous", json!(true)),
        ("sub", json!("not-a-uuid")),
        ("sub", json!("00000000-0000-0000-0000-000000000000")),
        ("nbf", json!(get_current_timestamp() + 3600)),
    ] {
        let mut claims = auth.claims();
        claims[field] = value;
        let token = TestAuth::token(&claims, "test-key");
        for path in ["/secured", "/mcp/secured"] {
            assert_eq!(
                auth.request(path, Some(&token)).await.status(),
                StatusCode::UNAUTHORIZED,
                "accepted bad {field} at {path}"
            );
        }
    }
    for missing in ["exp", "iss", "aud", "sub", "role", "is_anonymous"] {
        let mut claims = auth.claims();
        claims.as_object_mut().unwrap().remove(missing);
        let token = TestAuth::token(&claims, "test-key");
        assert_eq!(
            auth.request("/secured", Some(&token)).await.status(),
            StatusCode::UNAUTHORIZED,
            "accepted missing {missing}"
        );
    }
}

#[tokio::test]
async fn rejects_tampered_signatures_unknown_keys_and_symmetric_algorithms() {
    let auth = TestAuth::new().await;
    let token = TestAuth::token(&auth.claims(), "test-key");
    assert_eq!(
        auth.request("/secured", Some(&token)).await.status(),
        StatusCode::OK
    );
    let mut tampered = token.into_bytes();
    let signature_start = tampered.iter().rposition(|byte| *byte == b'.').unwrap() + 1;
    tampered[signature_start] = if tampered[signature_start] == b'A' {
        b'B'
    } else {
        b'A'
    };
    let tampered = String::from_utf8(tampered).unwrap();
    let unknown = TestAuth::token(&auth.claims(), "missing-key");
    let symmetric = encode(
        &Header::default(),
        &auth.claims(),
        &EncodingKey::from_secret(b"untrusted-secret"),
    )
    .unwrap();
    for token in [tampered, unknown, symmetric] {
        for path in ["/secured", "/mcp/secured"] {
            assert_eq!(
                auth.request(path, Some(&token)).await.status(),
                StatusCode::UNAUTHORIZED
            );
        }
    }
    assert_eq!(
        auth.requests.load(Ordering::SeqCst),
        1,
        "unknown kids must not trigger unlimited refreshes"
    );
}

#[tokio::test]
async fn auth_provider_outage_fails_closed() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let token = TestAuth::token(&json!({}), "test-key");
    let app = htp_api::app_with_auth(SupabaseAuth::new(&url));
    for path in ["/secured", "/mcp/secured"] {
        let response = app
            .clone()
            .oneshot(
                Request::get(path)
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}

#[derive(Clone, Default)]
struct WebsiteFixture(Arc<tokio::sync::Mutex<Vec<htp_shared::Website>>>);

async fn data_api_fixture(
    axum::extract::State(state): axum::extract::State<WebsiteFixture>,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
    method: axum::http::Method,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> axum::response::Response {
    use axum::response::IntoResponse as _;
    assert_eq!(headers["apikey"], "publishable-fixture-key");
    assert!(
        headers["authorization"]
            .to_str()
            .unwrap()
            .starts_with("Bearer ")
    );
    assert_eq!(query["select"], "id,fqdn,ga4_property_id");
    let input: Value = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body).unwrap()
    };
    assert!(
        input.get("owner_id").is_none(),
        "ownership must come from the caller JWT"
    );
    let mut rows = state.0.lock().await;
    let selected = query.get("id").and_then(|value| value.strip_prefix("eq."));
    let matches = |row: &htp_shared::Website| selected.is_none_or(|id| row.id.to_string() == id);
    match method {
        axum::http::Method::GET => {
            let mut result: Vec<_> = rows.iter().filter(|row| matches(row)).cloned().collect();
            result.sort_by(|a, b| a.fqdn.cmp(&b.fqdn));
            let offset = query
                .get("offset")
                .map_or(0, |value| value.parse::<usize>().unwrap());
            let limit = query
                .get("limit")
                .map_or(100, |value| value.parse::<usize>().unwrap());
            Json(
                result
                    .into_iter()
                    .skip(offset)
                    .take(limit)
                    .collect::<Vec<_>>(),
            )
            .into_response()
        }
        axum::http::Method::POST => {
            let fqdn = input["fqdn"].as_str().unwrap().to_owned();
            if rows.iter().any(|row| row.fqdn == fqdn) {
                return StatusCode::CONFLICT.into_response();
            }
            let row = htp_shared::Website {
                id: uuid::Uuid::from_u128(u128::try_from(rows.len()).unwrap() + 1),
                fqdn,
                ga4_property_id: None,
            };
            rows.push(row.clone());
            (StatusCode::CREATED, Json(vec![row])).into_response()
        }
        axum::http::Method::PATCH => {
            let result = rows.iter_mut().find(|row| matches(row)).map(|row| {
                if let Some(value) = input.get("ga4_property_id") {
                    row.ga4_property_id = value.as_str().map(str::to_owned);
                } else {
                    input["fqdn"].as_str().unwrap().clone_into(&mut row.fqdn);
                }
                row.clone()
            });
            Json(result.into_iter().collect::<Vec<_>>()).into_response()
        }
        axum::http::Method::DELETE => {
            let result: Vec<_> = rows.iter().filter(|row| matches(row)).cloned().collect();
            rows.retain(|row| !matches(row));
            Json(result).into_response()
        }
        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }
}

async fn website_request(
    auth: &TestAuth,
    method: &str,
    path: &str,
    body: Value,
) -> axum::response::Response {
    let token = TestAuth::token(&auth.claims(), "test-key");
    auth.app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn response_json(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn website_crud_uses_user_scoped_data_api_and_canonical_domains() {
    let fixture = WebsiteFixture::default();
    let routes = Router::new()
        .route("/rest/v1/websites", axum::routing::any(data_api_fixture))
        .with_state(fixture);
    let auth = TestAuth::with_routes(routes).await;
    let created = website_request(
        &auth,
        "POST",
        "/websites",
        json!({"fqdn": " WWW.DreamCleanMacon.COM. "}),
    )
    .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    assert_eq!(created.headers()["cache-control"], "no-store");
    let created = response_json(created).await;
    assert_eq!(created["fqdn"], "www.dreamcleanmacon.com");
    let path = format!("/websites/{}", created["id"].as_str().unwrap());
    let read = website_request(&auth, "GET", &path, Value::Null).await;
    assert_eq!(read.status(), StatusCode::OK);
    assert_eq!(response_json(read).await, created);
    assert_eq!(
        website_request(
            &auth,
            "POST",
            "/websites",
            json!({"fqdn":"WWW.DREAMCLEANMACON.COM"})
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    let changed =
        website_request(&auth, "PATCH", &path, json!({"fqdn":"updated.example.com"})).await;
    assert_eq!(changed.status(), StatusCode::OK);
    assert_eq!(response_json(changed).await["fqdn"], "updated.example.com");
    let listed = response_json(website_request(&auth, "GET", "/websites", Value::Null).await).await;
    assert_eq!(listed["items"][0]["fqdn"], "updated.example.com");
    assert_eq!(listed["has_more"], false);
    assert_eq!(
        website_request(&auth, "DELETE", &path, Value::Null)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        website_request(&auth, "GET", &path, Value::Null)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        website_request(&auth, "PATCH", &path, json!({"fqdn":"missing.example"}))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        website_request(&auth, "DELETE", &path, Value::Null)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn website_inputs_and_pagination_are_bounded() {
    let routes = Router::new()
        .route("/rest/v1/websites", axum::routing::any(data_api_fixture))
        .with_state(WebsiteFixture::default());
    let auth = TestAuth::with_routes(routes).await;
    assert_eq!(
        website_request(
            &auth,
            "POST",
            "/websites",
            json!({"fqdn":"https://example.com"})
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        website_request(
            &auth,
            "POST",
            "/websites",
            json!({"fqdn":"example.com","owner_id":"someone-else"})
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    for path in ["/websites?limit=0", "/websites?limit=101"] {
        assert_eq!(
            website_request(&auth, "GET", path, Value::Null)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    for fqdn in ["b.example.com", "a.example.com"] {
        assert_eq!(
            website_request(&auth, "POST", "/websites", json!({"fqdn":fqdn}))
                .await
                .status(),
            StatusCode::CREATED
        );
    }
    let first =
        response_json(website_request(&auth, "GET", "/websites?limit=1", Value::Null).await).await;
    assert_eq!(first["items"].as_array().unwrap().len(), 1);
    assert_eq!(first["items"][0]["fqdn"], "a.example.com");
    assert_eq!(first["has_more"], true);
    let second = response_json(
        website_request(&auth, "GET", "/websites?limit=1&offset=1", Value::Null).await,
    )
    .await;
    assert_eq!(second["items"][0]["fqdn"], "b.example.com");
    assert_eq!(second["has_more"], false);
}

#[tokio::test]
async fn every_website_operation_requires_authentication() {
    let app = htp_api::app();
    for (method, path) in [
        ("GET", "/websites"),
        (
            "GET",
            "/websites/00000000-0000-0000-0000-000000000001/repository/issues",
        ),
        ("POST", "/websites"),
        (
            "POST",
            "/websites/00000000-0000-0000-0000-000000000001/search/properties",
        ),
        (
            "POST",
            "/websites/00000000-0000-0000-0000-000000000001/search/dashboard",
        ),
        (
            "POST",
            "/websites/00000000-0000-0000-0000-000000000001/search/inspect",
        ),
        ("GET", "/websites/00000000-0000-0000-0000-000000000001"),
        ("PATCH", "/websites/00000000-0000-0000-0000-000000000001"),
        ("DELETE", "/websites/00000000-0000-0000-0000-000000000001"),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}

fn google_report_fixture(calls: Arc<AtomicUsize>) -> Router {
    let hits = calls;
    Router::new().route("/v1beta/properties/123456:runReport", axum::routing::post(move |headers: axum::http::HeaderMap, Json(input): Json<Value>| {
        let hits = hits.clone();
        async move {
            hits.fetch_add(1, Ordering::SeqCst);
            assert_eq!(headers["authorization"], "Bearer fixture-google-token");
            assert!(headers.get("apikey").is_none());
            assert!(headers.get("x-google-access-token").is_none());
            assert_eq!(input["dimensionFilter"]["filter"], json!({"fieldName":"hostName", "stringFilter":{"matchType":"EXACT", "value":"www.dreamcleanmacon.com", "caseSensitive":false}}));
            assert_eq!(input["dateRanges"], json!([{"startDate":"2026-10-01", "endDate":"2026-10-27"}]));
            assert_eq!(input["metrics"], json!([{"name":"activeUsers"},{"name":"sessions"},{"name":"screenPageViews"}]));
            assert_eq!(input["dimensions"], json!([{"name":"date"}]));
            Json(json!({"dimensionHeaders":[{"name":"date"}], "metricHeaders":[{"name":"activeUsers"},{"name":"sessions"},{"name":"screenPageViews"}], "rows":[{"dimensionValues":[{"value":"20261001"}],"metricValues":[{"value":"4"},{"value":"5"},{"value":"9"}]}], "rowCount":1, "metadata":{"timeZone":"America/New_York", "subjectToThresholding":true}}))
        }
    }))
}

#[tokio::test]
async fn analytics_checks_website_ownership_and_filters_google_reports() {
    let fixture = WebsiteFixture::default();
    fixture.0.lock().await.push(htp_shared::Website {
        id: uuid::Uuid::from_u128(1),
        fqdn: "www.dreamcleanmacon.com".into(),
        ga4_property_id: None,
    });
    let calls = Arc::new(AtomicUsize::new(0));
    let google = google_report_fixture(calls.clone());
    let routes = Router::new()
        .route("/rest/v1/websites", axum::routing::any(data_api_fixture))
        .with_state(fixture)
        .merge(google);
    let auth = TestAuth::with_routes(routes).await;
    let token = TestAuth::token(&auth.claims(), "test-key");
    let input = json!({"property_id":"123456", "start_date":"2026-10-01", "end_date":"2026-10-27"});
    let path = "/websites/00000000-0000-0000-0000-000000000001/analytics";
    let response = analytics_request(
        &auth,
        path,
        Some(&token),
        Some("fixture-google-token"),
        input.clone(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let result = response_json(response).await;
    assert_eq!(result["website"]["fqdn"], "www.dreamcleanmacon.com");
    assert_eq!(result["report"]["rows"][0]["metricValues"][0]["value"], "4");
    assert_eq!(result["report"]["metadata"]["subjectToThresholding"], true);
    assert!(!result.to_string().contains("fixture-google-token"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    assert_eq!(
        analytics_request(
            &auth,
            path,
            None,
            Some("fixture-google-token"),
            input.clone()
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        analytics_request(&auth, path, Some(&token), None, input.clone())
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    // An inaccessible record is hidden by Supabase RLS and must never reach Google.
    assert_eq!(
        analytics_request(
            &auth,
            "/websites/00000000-0000-0000-0000-000000000002/analytics",
            Some(&token),
            Some("fixture-google-token"),
            input.clone()
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let mut invalid = input.clone();
    invalid["property_id"] = json!("../arbitrary");
    assert_eq!(
        analytics_request(
            &auth,
            path,
            Some(&token),
            Some("fixture-google-token"),
            invalid
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    let mut invalid = input;
    invalid["start_date"] = json!("2026-02-30");
    assert_eq!(
        analytics_request(
            &auth,
            path,
            Some(&token),
            Some("fixture-google-token"),
            invalid
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

async fn analytics_request(
    auth: &TestAuth,
    path: &str,
    supabase: Option<&str>,
    google: Option<&str>,
    input: Value,
) -> axum::response::Response {
    let mut request = Request::post(path).header("content-type", "application/json");
    if let Some(token) = supabase {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    if let Some(token) = google {
        request = request.header("x-google-access-token", token);
    }
    auth.app
        .clone()
        .oneshot(request.body(Body::from(input.to_string())).unwrap())
        .await
        .unwrap()
}

#[tokio::test]
async fn analytics_sanitizes_google_errors_and_accepts_empty_reports() {
    use axum::response::IntoResponse as _;
    let fixture = WebsiteFixture::default();
    fixture.0.lock().await.push(htp_shared::Website {
        id: uuid::Uuid::from_u128(1),
        fqdn: "www.example.com".into(),
        ga4_property_id: None,
    });
    let google = Router::new().route("/v1beta/properties/123:runReport", axum::routing::post(|headers: axum::http::HeaderMap| async move {
        let token = headers["authorization"].to_str().unwrap();
        match token.strip_prefix("Bearer ").unwrap() {
            "empty" => Json(json!({"dimensionHeaders":[{"name":"date"}],"metricHeaders":[{"name":"activeUsers"}]})).into_response(),
            "malformed" => Json(json!({"unexpected":"body"})).into_response(),
            token => (StatusCode::from_u16(token.parse().unwrap()).unwrap(), Json(json!({"error":"sensitive upstream detail"}))).into_response(),
        }
    }));
    let routes = Router::new()
        .route("/rest/v1/websites", axum::routing::any(data_api_fixture))
        .with_state(fixture)
        .merge(google);
    let auth = TestAuth::with_routes(routes).await;
    let token = TestAuth::token(&auth.claims(), "test-key");
    let input = json!({"property_id":"123", "start_date":"2026-10-01", "end_date":"2026-10-01"});
    for (google, expected) in [
        ("401", 401),
        ("403", 403),
        ("429", 429),
        ("400", 400),
        ("404", 400),
        ("500", 502),
        ("malformed", 502),
        ("empty", 200),
    ] {
        let response = analytics_request(
            &auth,
            "/websites/00000000-0000-0000-0000-000000000001/analytics",
            Some(&token),
            Some(google),
            input.clone(),
        )
        .await;
        assert_eq!(response.status().as_u16(), expected);
        assert!(
            !response_json(response)
                .await
                .to_string()
                .contains("sensitive upstream detail")
        );
    }
}

#[tokio::test]
async fn dashboard_reads_saved_reports_without_google_credentials() {
    let fixture = WebsiteFixture::default();
    fixture.0.lock().await.push(htp_shared::Website {
        id: uuid::Uuid::from_u128(1),
        fqdn: "www.example.com".into(),
        ga4_property_id: Some("123".into()),
    });
    let calls = Arc::new(AtomicUsize::new(0));
    let hits = calls.clone();
    let saved = Router::new().route("/rest/v1/rpc/request_google_report", axum::routing::post(move |headers:axum::http::HeaderMap,Json(body):Json<Value>| {
        let hits=hits.clone(); async move {
            hits.fetch_add(1,Ordering::SeqCst);
            assert!(headers["authorization"].to_str().unwrap().starts_with("Bearer "));
            assert!(!headers.contains_key("x-google-access-token"));
            assert_eq!(headers["apikey"], "publishable-fixture-key");
            assert_eq!(body["p_kind"], "analytics"); assert_eq!(body["p_property_id"], "123");
            assert_eq!(body["p_start_date"], "2026-10-01");
            Json(json!({"data":{"summary":{"metricHeaders":[{"name":"activeUsers"}],"rows":[{"metricValues":[{"value":"8"}]}]},"daily":{},"pages":{},"channels":{},"devices":{}},"sync":{"state":"error","fetched_at":"2026-10-30T10:00:00Z","last_error":"google_quota_exceeded"}}))
        }
    }));
    let auth = TestAuth::with_routes(
        Router::new()
            .route("/rest/v1/websites", axum::routing::any(data_api_fixture))
            .with_state(fixture)
            .merge(saved),
    )
    .await;
    let token = TestAuth::token(&auth.claims(), "test-key");
    let input = json!({"property_id":"123","start_date":"2026-10-01","end_date":"2026-10-27"});
    let path = "/websites/00000000-0000-0000-0000-000000000001/analytics/dashboard";
    let response = analytics_request(&auth, path, Some(&token), None, input.clone()).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body = response_json(response).await;
    assert_eq!(
        body["report"]["summary"]["rows"][0]["metricValues"][0]["value"],
        "8"
    );
    assert_eq!(body["sync"]["state"], "error");
    let invalid = json!({"property_id":"456","start_date":"2026-10-01","end_date":"2026-10-27"});
    assert_eq!(
        analytics_request(&auth, path, Some(&token), None, invalid)
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        analytics_request(&auth, path, None, None, input)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn dashboard_returns_pending_instead_of_false_zeroes_before_first_sync() {
    let fixture = WebsiteFixture::default();
    fixture.0.lock().await.push(htp_shared::Website {
        id: uuid::Uuid::from_u128(1),
        fqdn: "www.example.com".into(),
        ga4_property_id: Some("123".into()),
    });
    let saved = Router::new().route(
        "/rest/v1/rpc/request_google_report",
        axum::routing::post(async || {
            Json(json!({"data":null,"sync":{"state":"pending","fetched_at":null}}))
        }),
    );
    let auth = TestAuth::with_routes(
        Router::new()
            .route("/rest/v1/websites", axum::routing::any(data_api_fixture))
            .with_state(fixture)
            .merge(saved),
    )
    .await;
    let token = TestAuth::token(&auth.claims(), "test-key");
    let response = analytics_request(
        &auth,
        "/websites/00000000-0000-0000-0000-000000000001/analytics/dashboard",
        Some(&token),
        None,
        json!({"property_id":"123","start_date":"2026-10-01","end_date":"2026-10-27"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let body = response_json(response).await;
    assert_eq!(body["code"], "report_pending");
    assert_eq!(body["sync"]["state"], "pending");
    assert!(body.get("report").is_none());
}

#[tokio::test]
async fn insight_routes_use_only_user_scoped_saved_data_and_validate_requests() {
    let fixture = WebsiteFixture::default();
    fixture.0.lock().await.push(htp_shared::Website {
        id: uuid::Uuid::from_u128(1),
        fqdn: "www.example.com".into(),
        ga4_property_id: Some("123".into()),
    });
    let hits = Arc::new(AtomicUsize::new(0));
    let calls = hits.clone();
    let reports = Router::new()
        .route(
            "/rest/v1/rpc/request_google_report",
            axum::routing::post(
                move |headers: axum::http::HeaderMap, Json(body): Json<Value>| {
                    let calls = calls.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(headers["apikey"], "publishable-fixture-key");
                        assert!(!headers.contains_key("x-google-access-token"));
                        assert_eq!(body["p_website_id"], "00000000-0000-0000-0000-000000000001");
                        Json(json!({"data":{"source":body["p_kind"]},"sync":{"state":"ready"}}))
                    }
                },
            ),
        )
        .route(
            "/rest/v1/rpc/google_insight_history",
            axum::routing::post(|Json(body): Json<Value>| async move {
                assert_eq!(body["p_before_id"], 100);
                Json(json!({"snapshots":[],"changes":[],"bindings":["locations/10"]}))
            }),
        )
        .route(
            "/rest/v1/rpc/set_business_location",
            axum::routing::post(|Json(body): Json<Value>| async move {
                assert_eq!(body["p_location_id"], "locations/10");
                Json(json!({"linked":body["p_linked"]}))
            }),
        );
    let auth = TestAuth::with_routes(
        Router::new()
            .route("/rest/v1/websites", axum::routing::any(data_api_fixture))
            .with_state(fixture)
            .merge(reports),
    )
    .await;
    let token = TestAuth::token(&auth.claims(), "test-key");
    let path = "/websites/00000000-0000-0000-0000-000000000001/insights/report";
    for kind in [
        "pagespeed",
        "crux",
        "conversions",
        "business_locations",
        "business_profile",
        "business_performance",
    ] {
        let body = json!({"kind":kind,"property_id":"123","start_date":"2026-10-01","end_date":"2026-10-28"});
        let response = analytics_request(&auth, path, Some(&token), None, body).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(response_json(response).await["data"]["source"], kind);
    }
    let body = json!({"kind":"business_profile","property_id":"locations/10","start_date":"2026-10-01","end_date":"2026-10-28","before_id":100});
    let response = analytics_request(
        &auth,
        "/websites/00000000-0000-0000-0000-000000000001/insights/history",
        Some(&token),
        None,
        body.clone(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(hits.load(Ordering::SeqCst), 6);
    let response = auth
        .app
        .clone()
        .oneshot(
            Request::put("/websites/00000000-0000-0000-0000-000000000001/business/location")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"location_id":"locations/10","linked":true}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn insight_validation_and_ownership_fail_before_reading_saved_data() {
    let fixture = WebsiteFixture::default();
    let auth = TestAuth::with_routes(
        Router::new()
            .route("/rest/v1/websites", axum::routing::any(data_api_fixture))
            .with_state(fixture),
    )
    .await;
    let token = TestAuth::token(&auth.claims(), "test-key");
    let path = "/websites/00000000-0000-0000-0000-000000000001/insights/report";
    let body = json!({"kind":"business_profile","property_id":"locations/10","start_date":"2026-10-01","end_date":"2026-10-28"});
    assert_eq!(
        analytics_request(&auth, path, None, None, body.clone())
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let mut invalid = body.clone();
    invalid["end_date"] = json!("2025-01-01");
    assert_eq!(
        analytics_request(&auth, path, Some(&token), None, invalid)
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        analytics_request(&auth, path, Some(&token), None, body)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn repository_rest_and_mcp_forward_only_the_current_user_identity() {
    let route = |headers: axum::http::HeaderMap, Json(body): Json<Value>| async move {
        assert!(
            headers["authorization"]
                .to_str()
                .unwrap()
                .starts_with("Bearer ")
        );
        assert_eq!(headers["apikey"], "publishable-fixture-key");
        Json(body)
    };
    let auth = TestAuth::with_routes(
        Router::new()
            .route(
                "/rest/v1/rpc/set_website_repository",
                axum::routing::post(route),
            )
            .route(
                "/rest/v1/rpc/website_repository_history",
                axum::routing::post(route),
            ),
    )
    .await;
    let token = TestAuth::token(&auth.claims(), "test-key");
    let path = "/websites/00000000-0000-0000-0000-000000000001/repository";
    let input = json!({"repository_url":"https://github.com/example/site.git/","branch":"main","enabled":true});
    let response = auth
        .app
        .clone()
        .oneshot(
            Request::put(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(input.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 10000).await.unwrap()).unwrap();
    assert_eq!(body["p_repository_url"], "https://github.com/example/site");
    assert_eq!(body["p_website_id"], "00000000-0000-0000-0000-000000000001");
    for (name, args, key, value) in [
        (
            "set_website_repository",
            json!({"fqdn":"EXAMPLE.COM.","repository_url":"https://github.com/example/site","enabled":false}),
            "p_enabled",
            json!(false),
        ),
        (
            "website_repository_history",
            json!({"fqdn":"example.com","start_date":"2026-10-01","end_date":"2026-10-30"}),
            "p_start_date",
            json!("2026-10-01"),
        ),
    ] {
        let response=auth.app.clone().oneshot(Request::post("/mcp/secured").header("host","localhost").header("authorization",format!("Bearer {token}")).header("content-type","application/json").header("accept","application/json, text/event-stream").header("mcp-protocol-version","2025-11-25").body(Body::from(json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}}).to_string())).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let result: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 10000).await.unwrap()).unwrap();
        assert_eq!(
            result["result"]["structuredContent"]["p_fqdn"],
            "example.com"
        );
        assert_eq!(result["result"]["structuredContent"][key], value);
    }
    let response = auth
        .app
        .clone()
        .oneshot(Request::get(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn mcp_research_discovers_websites_and_reads_all_saved_datasets() {
    let (auth, hits) = research_mcp_fixture().await;
    let token = TestAuth::token(&auth.claims(), "test-key");
    let first = response_json(
        research_mcp_call(&auth, Some(&token), "list_websites", json!({"limit":2})).await,
    )
    .await;
    assert_eq!(
        first["result"]["structuredContent"]["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(first["result"]["structuredContent"]["next_offset"], 2);
    let second = response_json(
        research_mcp_call(
            &auth,
            Some(&token),
            "list_websites",
            json!({"limit":2,"offset":2}),
        )
        .await,
    )
    .await;
    assert_eq!(
        second["result"]["structuredContent"]["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(second["result"]["structuredContent"]["has_more"], false);
    for dataset in [
        "sources",
        "snapshots",
        "profile_changes",
        "bing_sources",
        "bing_snapshots",
    ] {
        let args = json!({"fqdn":"WWW1.EXAMPLE.COM.","dataset":dataset,"limit":1});
        let response = research_mcp_call(&auth, Some(&token), "website_saved_data", args).await;
        assert_eq!(response.headers()["cache-control"], "no-store");
        let result = response_json(response).await;
        assert_eq!(result["result"]["isError"], false);
        assert_eq!(
            result["result"]["structuredContent"]["p_fqdn"],
            "www1.example.com"
        );
        assert_eq!(result["result"]["structuredContent"]["p_dataset"], dataset);
    }
    let result=response_json(research_mcp_call(&auth,Some(&token),"website_saved_data",json!({"fqdn":"www1.example.com","dataset":"snapshots","job_id":"00000000-0000-0000-0000-000000000001","before_id":"20","limit":5})).await).await;
    assert_eq!(result["result"]["structuredContent"]["p_before_id"], "20");
    assert_eq!(result["result"]["structuredContent"]["p_limit"], 5);
    for args in [
        json!({"fqdn":"bad","dataset":"sources"}),
        json!({"fqdn":"example.com","dataset":"sources","limit":0}),
        json!({"fqdn":"example.com","dataset":"sources","job_id":"invalid"}),
    ] {
        let result =
            response_json(research_mcp_call(&auth, Some(&token), "website_saved_data", args).await)
                .await;
        assert_eq!(result["result"]["isError"], true);
    }
    assert_eq!(hits.load(Ordering::SeqCst), 6);
    let result = response_json(
        research_mcp_call(
            &auth,
            Some(&token),
            "website_saved_data",
            json!({"fqdn":"hidden.example.com","dataset":"sources"}),
        )
        .await,
    )
    .await;
    assert_eq!(result["result"]["isError"], true);
    assert!(!result.to_string().contains("PRIVATE DATABASE DETAIL"));
    assert_eq!(
        research_mcp_call(
            &auth,
            None,
            "website_saved_data",
            json!({"fqdn":"example.com","dataset":"sources"})
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
}

async fn research_mcp_call(
    auth: &TestAuth,
    token: Option<&str>,
    name: &str,
    args: Value,
) -> axum::response::Response {
    let mut request = Request::post("/mcp/secured")
        .header("host", "localhost")
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", "2025-11-25");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    auth.app.clone().oneshot(request.body(Body::from(json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}}).to_string())).unwrap()).await.unwrap()
}

async fn research_mcp_fixture() -> (TestAuth, Arc<AtomicUsize>) {
    let fixture = WebsiteFixture::default();
    for n in 1..=3 {
        fixture.0.lock().await.push(htp_shared::Website {
            id: uuid::Uuid::from_u128(n),
            fqdn: format!("www{n}.example.com"),
            ga4_property_id: Some("123".into()),
        });
    }
    let hits = Arc::new(AtomicUsize::new(0));
    let calls = hits.clone();
    let reports = Router::new().route(
        "/rest/v1/rpc/website_saved_data",
        axum::routing::post(
            move |headers: axum::http::HeaderMap, Json(body): Json<Value>| {
                let calls = calls.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    assert!(
                        headers["authorization"]
                            .to_str()
                            .unwrap()
                            .starts_with("Bearer ")
                    );
                    assert_eq!(headers["apikey"], "publishable-fixture-key");
                    assert!(!headers.contains_key("x-google-access-token"));
                    if body["p_fqdn"] == "hidden.example.com" {
                        return (
                            StatusCode::FORBIDDEN,
                            Json(json!({"message":"PRIVATE DATABASE DETAIL"})),
                        );
                    }
                    (StatusCode::OK, Json(body))
                }
            },
        ),
    );
    let auth = TestAuth::with_routes(
        Router::new()
            .route("/rest/v1/websites", axum::routing::any(data_api_fixture))
            .with_state(fixture)
            .merge(reports),
    )
    .await;
    (auth, hits)
}

#[tokio::test]
async fn mcp_unauthorized_response_discovers_the_project_oauth_server() {
    let auth = TestAuth::new().await;
    let rejected = auth.request("/mcp/secured", None).await;
    assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
    let challenge = rejected.headers()["www-authenticate"].to_str().unwrap();
    assert!(challenge.contains("resource_metadata=\"http://127.0.0.1:3000/.well-known/oauth-protected-resource/mcp/secured\""));
    for path in [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp/secured",
    ] {
        let response = auth
            .app
            .clone()
            .oneshot(
                Request::get(path)
                    .header("host", "attacker.invalid")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let data = response_json(response).await;
        assert_eq!(data["resource"], "http://127.0.0.1:3000/mcp/secured");
        assert_eq!(
            data["authorization_servers"],
            json!([format!("{}/auth/v1", auth.url)])
        );
        assert_eq!(data["bearer_methods_supported"], json!(["header"]));
        assert!(!data.to_string().contains("attacker.invalid"));
    }
}

#[tokio::test]
async fn bing_reports_use_only_owned_saved_data_and_preserve_pending_state() {
    let fixture = WebsiteFixture::default();
    fixture.0.lock().await.push(htp_shared::Website {
        id: uuid::Uuid::from_u128(1),
        fqdn: "example.com".into(),
        ga4_property_id: None,
    });
    let hits = Arc::new(AtomicUsize::new(0));
    let calls = hits.clone();
    let saved = Router::new().route("/rest/v1/rpc/request_bing_report", axum::routing::post(
        move |headers: axum::http::HeaderMap, Json(body): Json<Value>| {
            let calls = calls.clone();
            async move {
                assert_eq!(headers["apikey"], "publishable-fixture-key");
                assert!(headers["authorization"].to_str().unwrap().starts_with("Bearer "));
                assert!(!headers.contains_key("x-bing-access-token"));
                assert_eq!(body, json!({"p_website_id":"00000000-0000-0000-0000-000000000001"}));
                let first = calls.fetch_add(1, Ordering::SeqCst) == 0;
                Json(json!({"data": if first { Value::Null } else { json!({"site_url":"https://example.com/","sections":{"traffic":{"rows":[],"error":null}}}) },"sync":{"state":if first {"pending"} else {"ready"},"cadence":"daily"}}))
            }
        }
    ));
    let auth = TestAuth::with_routes(
        Router::new()
            .route("/rest/v1/websites", axum::routing::any(data_api_fixture))
            .with_state(fixture)
            .merge(saved),
    )
    .await;
    let token = TestAuth::token(&auth.claims(), "test-key");
    let path = "/websites/00000000-0000-0000-0000-000000000001/bing/dashboard";
    assert_eq!(
        analytics_request(&auth, path, None, None, json!({}))
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        analytics_request(
            &auth,
            path,
            Some(&token),
            None,
            json!({"site_url":"https://other.com/"})
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let pending = analytics_request(&auth, path, Some(&token), None, json!({})).await;
    assert_eq!(pending.status(), StatusCode::ACCEPTED);
    assert_eq!(response_json(pending).await["code"], "report_pending");
    let ready =
        response_json(analytics_request(&auth, path, Some(&token), None, json!({})).await).await;
    assert_eq!(ready["site_url"], "https://example.com/");
    assert_eq!(ready["sync"]["cadence"], "daily");
    let missing = "/websites/00000000-0000-0000-0000-000000000099/bing/dashboard";
    assert_eq!(
        analytics_request(&auth, missing, Some(&token), None, json!({}))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(hits.load(Ordering::SeqCst), 2);
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn mcp_management_crud_reuses_rest_validation_and_owner_identity() {
    let auth = TestAuth::with_routes(
        Router::new()
            .route("/rest/v1/websites", axum::routing::any(data_api_fixture))
            .with_state(WebsiteFixture::default()),
    )
    .await;
    let token = TestAuth::token(&auth.claims(), "test-key");
    let create = json!({"fqdn":" WWW.VoteHatcher.COM. "});
    let result = response_json(
        research_mcp_call(&auth, Some(&token), "create_website", create.clone()).await,
    )
    .await;
    assert_eq!(result["result"]["isError"], false);
    let website = &result["result"]["structuredContent"];
    assert_eq!(website["fqdn"], "www.votehatcher.com");
    let id = website["id"].as_str().unwrap();
    let target = json!({"website_id":id});
    let read =
        response_json(research_mcp_call(&auth, Some(&token), "get_website", target.clone()).await)
            .await;
    assert_eq!(&read["result"]["structuredContent"], website);
    let conflict =
        response_json(research_mcp_call(&auth, Some(&token), "create_website", create).await).await;
    assert_eq!(conflict["result"]["isError"], true);
    assert_eq!(conflict["result"]["structuredContent"]["status"], 409);
    for property in [json!("12345"), Value::Null] {
        let bound = response_json(
            research_mcp_call(
                &auth,
                Some(&token),
                "set_website_ga4_property",
                json!({"website_id":id,"property_id":property}),
            )
            .await,
        )
        .await;
        assert_eq!(bound["result"]["isError"], false);
        assert_eq!(
            bound["result"]["structuredContent"]["ga4_property_id"],
            property
        );
    }
    for (name, args) in [
        ("create_website", json!({"fqdn":"https://example.com/path"})),
        (
            "set_website_ga4_property",
            json!({"website_id":id,"property_id":"0invalid"}),
        ),
    ] {
        let invalid = response_json(research_mcp_call(&auth, Some(&token), name, args).await).await;
        assert_eq!(invalid["result"]["isError"], true);
        assert_eq!(invalid["result"]["structuredContent"]["status"], 400);
    }
    let renamed = response_json(
        research_mcp_call(
            &auth,
            Some(&token),
            "update_website",
            json!({"website_id":id,"fqdn":"renamed.example.com"}),
        )
        .await,
    )
    .await;
    assert_eq!(
        renamed["result"]["structuredContent"]["fqdn"],
        "renamed.example.com"
    );
    let deleted = response_json(
        research_mcp_call(&auth, Some(&token), "delete_website", target.clone()).await,
    )
    .await;
    assert_eq!(deleted["result"]["structuredContent"]["deleted"], true);
    let missing =
        response_json(research_mcp_call(&auth, Some(&token), "get_website", target.clone()).await)
            .await;
    assert_eq!(missing["result"]["isError"], true);
    assert_eq!(missing["result"]["structuredContent"]["status"], 404);
    for (name, args) in [
        ("create_website", json!({"fqdn":"example.com"})),
        ("delete_website", target.clone()),
        (
            "request_website_report",
            json!({"website_id":id,"kind":"bing"}),
        ),
        (
            "import_website_audit",
            json!({"website_id":id,"report_json":"{}"}),
        ),
    ] {
        assert_eq!(
            research_mcp_call(&auth, None, name, args).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
    // Unknown ownership fields and path injection are rejected by MCP argument decoding.
    for args in [
        json!({"fqdn":"example.com","owner_id":"attacker"}),
        json!({"website_id":"../other"}),
    ] {
        let name = if args.get("fqdn").is_some() {
            "create_website"
        } else {
            "delete_website"
        };
        let invalid = response_json(research_mcp_call(&auth, Some(&token), name, args).await).await;
        assert!(invalid.get("error").is_some() || invalid["result"]["isError"] == true);
    }
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn mcp_report_and_audit_management_use_fixed_owner_scoped_handlers() {
    let fixture = WebsiteFixture::default();
    fixture.0.lock().await.push(htp_shared::Website {
        id: uuid::Uuid::from_u128(1),
        fqdn: "example.com".into(),
        ga4_property_id: Some("123".into()),
    });
    let hits = Arc::new(AtomicUsize::new(0));
    let capture = hits.clone();
    let rpc = Router::new().route(
        "/rest/v1/rpc/{name}",
        axum::routing::post(
            move |axum::extract::Path(name): axum::extract::Path<String>,
                  headers: axum::http::HeaderMap,
                  Json(body): Json<Value>| {
                let capture = capture.clone();
                async move {
                    capture.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(headers["apikey"], "publishable-fixture-key");
                    assert!(
                        headers["authorization"]
                            .to_str()
                            .unwrap()
                            .starts_with("Bearer ")
                    );
                    assert!(!headers.contains_key("x-google-access-token"));
                    assert!(matches!(
                        name.as_str(),
                        "request_google_report"
                            | "request_bing_report"
                            | "set_business_location"
                            | "seosmith_audit_history"
                            | "seosmith_audit_detail"
                            | "import_seosmith_audit"
                    ));
                    if body["p_website_id"] != uuid::Uuid::from_u128(1).to_string() {
                        return (
                            StatusCode::FORBIDDEN,
                            Json(json!({"error":"PRIVATE DATABASE DETAIL"})),
                        );
                    }
                    (
                        StatusCode::OK,
                        Json(
                            json!({"data":null,"sync":{"state":"pending"},"input":body,"rpc":name}),
                        ),
                    )
                }
            },
        ),
    );
    let auth = TestAuth::with_routes(
        Router::new()
            .route("/rest/v1/websites", axum::routing::any(data_api_fixture))
            .with_state(fixture)
            .merge(rpc),
    )
    .await;
    let token = TestAuth::token(&auth.claims(), "test-key");
    let id = uuid::Uuid::from_u128(1).to_string();
    for kind in [
        "analytics",
        "search",
        "properties",
        "pagespeed",
        "crux",
        "conversions",
        "business_locations",
        "business_profile",
        "business_performance",
        "bing",
    ] {
        let property = if kind == "search" {
            "sc-domain:example.com"
        } else {
            "123"
        };
        let result = response_json(research_mcp_call(&auth, Some(&token), "request_website_report", json!({"website_id":id,"kind":kind,"property_id":property,"start_date":"2026-10-01","end_date":"2026-10-28"})).await).await;
        assert_eq!(result["result"]["isError"], false, "{kind}: {result}");
        let body = &result["result"]["structuredContent"];
        assert!(body["code"] == "report_pending" || body["sync"]["state"] == "pending");
    }
    for (name, args, rpc) in [
        (
            "set_website_business_location",
            json!({"website_id":id,"location_id":"locations/123","linked":true}),
            "set_business_location",
        ),
        (
            "website_audit_history",
            json!({"website_id":id,"limit":1,"before":"2026-10-01T00:00:00Z","before_id":id}),
            "seosmith_audit_history",
        ),
        (
            "website_audit_detail",
            json!({"website_id":id,"delivery_id":id}),
            "seosmith_audit_detail",
        ),
        (
            "import_website_audit",
            json!({"website_id":id,"report_json":"{}"}),
            "import_seosmith_audit",
        ),
    ] {
        let result = response_json(research_mcp_call(&auth, Some(&token), name, args).await).await;
        assert_eq!(result["result"]["isError"], false, "{result}");
        assert_eq!(result["result"]["structuredContent"]["rpc"], rpc);
    }
    assert_eq!(hits.load(Ordering::SeqCst), 14);
    for args in [
        json!({"website_id":id,"kind":"analytics","property_id":"123","start_date":"2026-02-30","end_date":"2026-10-01"}),
        json!({"website_id":id,"kind":"search","property_id":"sc-domain:other.com","start_date":"2026-10-01","end_date":"2026-10-28"}),
        json!({"website_id":uuid::Uuid::from_u128(999).to_string(),"kind":"bing"}),
    ] {
        let result = response_json(
            research_mcp_call(&auth, Some(&token), "request_website_report", args).await,
        )
        .await;
        assert_eq!(result["result"]["isError"], true);
    }
    assert_eq!(hits.load(Ordering::SeqCst), 14);
    let denied = response_json(
        research_mcp_call(
            &auth,
            Some(&token),
            "website_audit_detail",
            json!({"website_id":uuid::Uuid::from_u128(999).to_string(),"delivery_id":id}),
        )
        .await,
    )
    .await;
    assert_eq!(denied["result"]["isError"], true);
    assert!(!denied.to_string().contains("PRIVATE DATABASE DETAIL"));
}

#[tokio::test]
async fn mcp_audit_import_accepts_large_envelopes_but_bounds_report_bytes() {
    let hits = Arc::new(AtomicUsize::new(0));
    let capture = hits.clone();
    let auth = TestAuth::with_routes(
        Router::new().route(
            "/rest/v1/rpc/import_seosmith_audit",
            axum::routing::post(move |Json(body): Json<Value>| {
                let capture = capture.clone();
                async move {
                    capture.fetch_add(1, Ordering::SeqCst);
                    assert!(body["p_report_json"].as_str().unwrap().len() > 4 * 1024 * 1024);
                    Json(json!({"accepted":true}))
                }
            })
            .layer(axum::extract::DefaultBodyLimit::max(32 * 1024 * 1024)),
        ),
    )
    .await;
    let token = TestAuth::token(&auth.claims(), "test-key");
    for (size, accepted) in [(4 * 1024 * 1024 + 1, true), (16 * 1024 * 1024 + 1, false)] {
        let result = response_json(research_mcp_call(&auth, Some(&token), "import_website_audit",
            json!({"website_id":uuid::Uuid::from_u128(1).to_string(),"report_json":"x".repeat(size)})).await).await;
        assert_eq!(result["result"]["isError"], !accepted, "{result}");
        if accepted {
            assert_eq!(result["result"]["structuredContent"]["accepted"], true);
        } else {
            assert_eq!(result["result"]["structuredContent"]["status"], 413);
        }
    }
    assert_eq!(hits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn repository_issues_check_owner_and_handle_missing_binding() {
    let auth = TestAuth::with_routes(Router::new().route(
        "/rest/v1/rpc/website_repository_history",
        axum::routing::post(
            |headers: axum::http::HeaderMap, Json(body): Json<Value>| async move {
                assert!(
                    headers["authorization"]
                        .to_str()
                        .unwrap()
                        .starts_with("Bearer ")
                );
                assert_eq!(headers["apikey"], "publishable-fixture-key");
                if body["p_website_id"] == "00000000-0000-0000-0000-000000000001" {
                    (StatusCode::OK, Json(json!({"repository":null})))
                } else {
                    (
                        StatusCode::FORBIDDEN,
                        Json(json!({"message":"private database detail"})),
                    )
                }
            },
        ),
    ))
    .await;
    let token = TestAuth::token(&auth.claims(), "test-key");
    for (id, expected) in [(1, StatusCode::OK), (2, StatusCode::FORBIDDEN)] {
        let response = auth
            .app
            .clone()
            .oneshot(
                Request::get(format!(
                    "/websites/00000000-0000-0000-0000-{id:012}/repository/issues"
                ))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let body = response_json(response).await;
        if id == 1 {
            assert_eq!(
                body,
                json!({"repository_url":null,"issues":[],"has_more":false})
            );
        } else {
            assert!(!body.to_string().contains("private database detail"));
        }
    }
}
