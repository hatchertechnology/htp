//! Synthetic MCP transport tests: no JWT construction or hosted endpoints.
use super::*;
use axum::{
    Json, Router,
    body::Body,
    http::{Request, StatusCode},
    routing::any,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tower::ServiceExt as _;
use uuid::Uuid;

const SITE: Uuid = Uuid::from_u128(1);
const OWNER: Uuid = Uuid::from_u128(2);
const FORM: Uuid = Uuid::from_u128(3);
const RESPONSE: Uuid = Uuid::from_u128(4);
type Seen = Arc<Mutex<Vec<(String, Value)>>>;

fn server(origin: &str, flags: [bool; 3], scoped: bool) -> WebsiteMcp {
    let store = crate::websites::WebsiteStore::new(origin, "synthetic-publishable");
    let pilot = scoped.then_some(crate::form_inbox::PilotScope {
        website_id: SITE,
        owner_id: OWNER,
    });
    let inbox = crate::form_inbox::FormInboxState {
        reader: store.forms_reader(),
        enabled: flags[0],
        pilot,
    };
    let save = crate::form_save::FormSaveState {
        saver: store.forms_saver(),
        enabled: flags[1],
        pilot,
    };
    let responses = crate::form_responses::ResponseState {
        writer: store.forms_response_writer(),
        enabled: flags[2],
        pilot,
    };
    WebsiteMcp {
        tool_router: owner_tool_router(false, &inbox, &save, &responses),
        store,
        inbox,
        save,
        responses,
        forms: crate::form_verification::FormVerificationState {
            verifier: crate::form_verification::FormVerifier::new(origin, "synthetic-publishable"),
            enabled: false,
        },
        management: Router::new(),
        exports: Arc::default(),
    }
}
fn app(mcp: WebsiteMcp) -> Router {
    let service = StreamableHttpService::new(
        move || Ok(mcp.clone()),
        LocalSessionManager::default().into(),
        config(),
    );
    Router::new().nest_service("/mcp", service)
}
async fn rpc(app: Router, method: &str, params: Value, owner: Option<Uuid>, bearer: bool) -> Value {
    let mut request = Request::post("/mcp")
        .header("host", "localhost")
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", "2025-11-25")
        .body(Body::from(
            json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}).to_string(),
        ))
        .unwrap();
    // Trusted authentication middleware's output, never a manufactured JWT.
    if let Some(id) = owner {
        request
            .extensions_mut()
            .insert(crate::auth::AuthenticatedUser { id });
    }
    if bearer {
        request
            .headers_mut()
            .insert("authorization", "Bearer synthetic-opaque".parse().unwrap());
    }
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
async fn call(app: Router, name: &str, args: Value, owner: Option<Uuid>, bearer: bool) -> Value {
    rpc(
        app,
        "tools/call",
        json!({"name":name,"arguments":args}),
        owner,
        bearer,
    )
    .await
}
fn args() -> Value {
    json!({"website_id":SITE,"form_id":FORM,"response_id":RESPONSE,"confirm_delete":true})
}
async fn fixture() -> (String, Seen, tokio::task::JoinHandle<()>) {
    let seen: Seen = Arc::default();
    let capture = seen.clone();
    let upstream = Router::new().route("/{*path}", any(move |request: Request<Body>| {
        let seen = capture.clone();
        async move {
            assert_eq!(request.headers()["authorization"], "Bearer synthetic-opaque");
            assert_eq!(request.headers()["apikey"], "synthetic-publishable");
            let uri = request.uri().to_string();
            let bytes = axum::body::to_bytes(request.into_body(), 1 << 20).await.unwrap();
            let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            seen.lock().unwrap().push((uri.clone(), body.clone()));
            if uri.contains("save_website_form") {
                if body["p_name"] == "uncertain" { return (StatusCode::BAD_GATEWAY, Json(json!({"secret":"never expose"}))); }
                return (StatusCode::OK, Json(json!({"id":FORM,"form_key":body["p_form_key"],"name":body["p_name"],"fields":body["p_fields"],"active":body["p_active"]})));
            }
            if uri.contains("delete_website_form_response") {
                if body["p_response_id"] == json!(Uuid::from_u128(90)) {
                    return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"code":"55000","message":"private"})));
                }
                if body["p_response_id"] == json!(Uuid::from_u128(91)) {
                    return (StatusCode::BAD_GATEWAY, Json(json!({"message":"private"})));
                }
                return (StatusCode::OK, Json(json!(true)));
            }
            if uri.contains("website_form_hosts") { return (StatusCode::OK, Json(json!([{"id":FORM,"hostname":"example.test","verified_at":"2026-11-01","challenge_hash":"secret"}]))); }
            (StatusCode::OK, Json(json!([])))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, upstream).await.unwrap();
    });
    (origin, seen, task)
}

#[tokio::test]
async fn save_schema_advertises_field_objects_and_preserves_object_inputs() {
    let (origin, seen, task) = fixture().await;
    let app = app(server(&origin, [false, true, false], true));
    let discovery = rpc(app.clone(), "tools/list", json!({}), None, false).await;
    let tool = discovery["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "save_website_form")
        .unwrap();
    // Inspect the actual advertised transport schema, including resolved items.
    fn resolve<'a>(root: &'a Value, schema: &'a Value) -> &'a Value {
        match schema["$ref"].as_str() {
            Some(reference) => root.pointer(reference.strip_prefix('#').unwrap()).unwrap(),
            None => schema,
        }
    }
    let schema = &tool["inputSchema"];
    let form = resolve(schema, &schema["properties"]["form"]);
    let fields = &form["properties"]["fields"];
    assert_eq!(fields["type"], "array", "{tool}");
    let item = resolve(schema, &fields["items"]);
    assert_eq!(item["type"], "object", "{tool}");
    assert_eq!(item["additionalProperties"], false);
    let properties = &item["properties"];
    for (key, ty) in [
        ("key", "string"),
        ("label", "string"),
        ("kind", "string"),
        ("required", "boolean"),
        ("max_length", "integer"),
    ] {
        assert_eq!(
            resolve(schema, &properties[key])["type"],
            ty,
            "{key}: {tool}"
        );
        assert!(item["required"].as_array().unwrap().contains(&json!(key)));
    }
    assert_eq!(properties.as_object().unwrap().len(), 5);
    assert_eq!(
        resolve(schema, &properties["kind"])["enum"],
        json!(["text", "email", "telephone", "multiline"])
    );
    assert_eq!(properties["max_length"]["minimum"], 1);
    assert_eq!(properties["max_length"]["maximum"], 5000);

    let fields = json!([
        {"key":"name","label":"Name","kind":"text","required":true,"max_length":100},
        {"key":"email","label":"Email","kind":"email","required":true,"max_length":254},
        {"key":"phone","label":"Phone","kind":"telephone","required":false,"max_length":50},
        {"key":"message","label":"Message","kind":"multiline","required":false,"max_length":5000}
    ]);
    for form_id in [Value::Null, json!(FORM)] {
        let result = call(
            app.clone(),
            "save_website_form",
            json!({
                "website_id":SITE, "form": {"form_id":form_id,"form_key":"contact",
                    "name":"Contact","fields":fields,"active":false,"host_ids":[]}
            }),
            Some(OWNER),
            true,
        )
        .await;
        assert_eq!(result["result"]["isError"], false, "{result}");
        assert_eq!(result["result"]["structuredContent"]["fields"], fields);
    }
    let requests = seen.lock().unwrap();
    assert_eq!(requests.len(), 2);
    for (_, body) in requests.iter() {
        assert_eq!(body["p_fields"], fields);
    }
    assert_eq!(requests[0].1["p_form_id"], Value::Null);
    assert_eq!(requests[1].1["p_form_id"], json!(FORM));
    task.abort();
}

#[tokio::test]
async fn discovery_is_independent_default_off_and_requires_pilot_pair() {
    for bits in 0..8 {
        let flags = [bits & 1 != 0, bits & 2 != 0, bits & 4 != 0];
        for scoped in [false, true] {
            let result = rpc(
                app(server("http://127.0.0.1:1", flags, scoped)),
                "tools/list",
                json!({}),
                None,
                false,
            )
            .await;
            let tools = result["result"]["tools"].as_array().unwrap();
            for (name, enabled) in [
                ("list_form_hosts", flags[0]),
                ("list_website_forms", flags[0]),
                ("list_form_responses", flags[0]),
                ("save_website_form", flags[1]),
                ("delete_form_response", flags[2]),
            ] {
                assert_eq!(
                    tools.iter().any(|t| t["name"] == name),
                    enabled && scoped,
                    "{name}: {flags:?}/{scoped}"
                );
            }
            if let Some(delete) = tools.iter().find(|t| t["name"] == "delete_form_response") {
                assert_eq!(delete["annotations"]["destructiveHint"], true);
                assert_eq!(delete["inputSchema"]["additionalProperties"], false);
            }
        }
    }
}

#[tokio::test]
async fn typed_owner_tools_keep_pilot_auth_bounds_and_explicit_delete() {
    let (origin, seen, task) = fixture().await;
    let app = app(server(&origin, [true; 3], true));
    for (owner, bearer, code) in [
        (None, true, "unauthorized"),
        (Some(Uuid::from_u128(99)), true, "not_found"),
        (Some(OWNER), false, "unauthorized"),
    ] {
        let result = call(app.clone(), "delete_form_response", args(), owner, bearer).await;
        assert_eq!(result["result"]["isError"], true);
        assert_eq!(result["result"]["structuredContent"]["code"], code);
    }
    let mut other = args();
    other["website_id"] = json!(Uuid::from_u128(99));
    let result = call(
        app.clone(),
        "delete_form_response",
        other,
        Some(OWNER),
        true,
    )
    .await;
    assert_eq!(result["result"]["structuredContent"]["code"], "not_found");
    let mut unconfirmed = args();
    unconfirmed["confirm_delete"] = json!(false);
    let result = call(
        app.clone(),
        "delete_form_response",
        unconfirmed,
        Some(OWNER),
        true,
    )
    .await;
    assert_eq!(
        result["result"]["structuredContent"]["code"],
        "explicit_delete_required"
    );
    for input in [
        json!({"website_id":SITE,"limit":0}),
        json!({"website_id":SITE,"limit":101}),
        json!({"website_id":SITE,"url":"https://example.test"}),
    ] {
        let result = call(app.clone(), "list_form_hosts", input, Some(OWNER), true).await;
        assert!(result.get("error").is_some() || result["result"]["isError"] == true);
    }
    assert!(seen.lock().unwrap().is_empty());
    task.abort();
}

#[tokio::test]
async fn owner_tools_use_typed_payloads_and_preserve_bounded_results() {
    let (origin, seen, task) = fixture().await;
    let app = app(server(&origin, [true; 3], true));
    let hosts = call(
        app.clone(),
        "list_form_hosts",
        json!({"website_id":SITE,"limit":2,"offset":4}),
        Some(OWNER),
        true,
    )
    .await;
    assert_eq!(hosts["result"]["isError"], false);
    assert!(!hosts.to_string().contains("challenge_hash"));
    assert_eq!(
        hosts["result"]["structuredContent"]["items"][0]["verified_at"],
        "2026-11-01"
    );
    for (name, input) in [
        (
            "list_website_forms",
            json!({"website_id":SITE,"limit":2,"offset":4}),
        ),
        (
            "list_form_responses",
            json!({"website_id":SITE,"form_id":FORM,"limit":2,"offset":4}),
        ),
    ] {
        let result = call(app.clone(), name, input, Some(OWNER), true).await;
        assert_eq!(result["result"]["isError"], false);
    }
    for active in [false, true] {
        let result = call(app.clone(), "save_website_form", json!({"website_id":SITE,"form":{"form_id":active.then_some(FORM),"form_key":"contact","name":"Contact","fields":[{"key":"name","kind":"text"}],"active":active,"host_ids":[FORM]}}), Some(OWNER), true).await;
        assert_eq!(result["result"]["isError"], false, "{result}");
        assert_eq!(result["result"]["structuredContent"]["active"], active);
    }
    let unknown = call(app.clone(), "save_website_form", json!({"website_id":SITE,"form":{"form_key":"contact","name":"uncertain","fields":[{}],"active":false}}), Some(OWNER), true).await;
    assert_eq!(
        unknown["result"]["structuredContent"]["code"],
        "save_unknown_outcome"
    );
    assert!(!unknown.to_string().contains("never expose"));
    let result = call(app, "delete_form_response", args(), Some(OWNER), true).await;
    assert_eq!(
        result["result"]["structuredContent"],
        json!({"id":RESPONSE,"deleted":true})
    );
    let requests = seen.lock().unwrap();
    assert_eq!(requests.len(), 7); // No retries, including uncertain save.
    for (uri, _) in requests.iter().take(3) {
        assert!(uri.contains("limit=3"));
        assert!(uri.contains("offset=4"));
        assert!(uri.contains(&format!("website_id=eq.{SITE}")));
    }
    assert!(requests[2].0.contains(&format!("form_id=eq.{FORM}")));
    assert_eq!(requests[3].1["p_form_id"], Value::Null);
    assert_eq!(requests[4].1["p_form_id"], json!(FORM));
    assert_eq!(requests[4].1["p_host_ids"], json!([FORM]));
    assert_eq!(
        requests[6].1,
        json!({"p_website_id":SITE,"p_form_id":FORM,"p_response_id":RESPONSE})
    );
    task.abort();
}

#[tokio::test]
async fn every_operation_rejects_wrong_scope_and_disabled_state_before_upstream() {
    let operations = [
        ("list_form_hosts", json!({"website_id":SITE})),
        ("list_website_forms", json!({"website_id":SITE})),
        (
            "list_form_responses",
            json!({"website_id":SITE,"form_id":FORM}),
        ),
        (
            "save_website_form",
            json!({"website_id":SITE,"form":{"form_key":"contact","name":"Contact","fields":[{}],"active":false}}),
        ),
        ("delete_form_response", args()),
    ];
    let (origin, seen, task) = fixture().await;
    let enabled = server(&origin, [true; 3], true);
    let mut disabled = enabled.clone();
    disabled.inbox.enabled = false;
    disabled.save.enabled = false;
    disabled.responses.enabled = false;
    // Keep routes registered to exercise runtime defenses as well as discovery.
    for (name, input) in operations {
        for (caller, expected) in [
            (None, "unauthorized"),
            (Some(Uuid::from_u128(99)), "not_found"),
        ] {
            let result = call(app(enabled.clone()), name, input.clone(), caller, true).await;
            assert_eq!(
                result["result"]["structuredContent"]["code"], expected,
                "{name}: {result}"
            );
        }
        let mut wrong_site = input.clone();
        wrong_site["website_id"] = json!(Uuid::from_u128(99));
        let result = call(app(enabled.clone()), name, wrong_site, Some(OWNER), true).await;
        assert_eq!(
            result["result"]["structuredContent"]["code"], "not_found",
            "{name}"
        );
        let result = call(app(disabled.clone()), name, input, Some(OWNER), true).await;
        assert_eq!(result["result"]["isError"], true, "{name}");
    }
    for bad_form in [
        json!({"form_key":"Invalid-key","name":"Contact","fields":[{}],"active":false}),
        json!({"form_key":"contact","name":"Contact","fields":[],"active":false}),
        json!({"form_key":"contact","name":"Contact","fields":[{}],"active":false,"owner_id":OWNER}),
    ] {
        let result = call(
            app(enabled.clone()),
            "save_website_form",
            json!({"website_id":SITE,"form":bad_form}),
            Some(OWNER),
            true,
        )
        .await;
        assert!(result.get("error").is_some() || result["result"]["isError"] == true);
    }
    let mut bulk = args();
    bulk["response_ids"] = json!([RESPONSE]);
    let result = call(
        app(enabled),
        "delete_form_response",
        bulk,
        Some(OWNER),
        true,
    )
    .await;
    assert!(result.get("error").is_some() || result["result"]["isError"] == true);
    assert!(seen.lock().unwrap().is_empty());
    task.abort();
}

#[tokio::test]
async fn delete_busy_and_uncertain_outcomes_remain_errors_without_retry() {
    let (origin, seen, task) = fixture().await;
    let app = app(server(&origin, [true; 3], true));
    for (id, code) in [
        (90, "response_notification_sending"),
        (91, "response_delete_unknown_outcome"),
    ] {
        let mut input = args();
        input["response_id"] = json!(Uuid::from_u128(id));
        let result = call(
            app.clone(),
            "delete_form_response",
            input,
            Some(OWNER),
            true,
        )
        .await;
        assert_eq!(result["result"]["isError"], true);
        assert_eq!(result["result"]["structuredContent"]["code"], code);
        assert!(!result.to_string().contains("private"));
    }
    assert_eq!(seen.lock().unwrap().len(), 2);
    task.abort();
}

#[tokio::test]
async fn forms_result_preserves_error_status_and_unknown_success() {
    use axum::response::IntoResponse;
    for status in [
        StatusCode::BAD_REQUEST,
        StatusCode::UNAUTHORIZED,
        StatusCode::NOT_FOUND,
        StatusCode::CONFLICT,
        StatusCode::BAD_GATEWAY,
        StatusCode::SERVICE_UNAVAILABLE,
    ] {
        let result = forms_result(
            (
                status,
                Json(json!({"code":"synthetic","error":"Public message"})),
            )
                .into_response(),
        )
        .await;
        assert_eq!(result.is_error, Some(true));
        assert_eq!(
            result.structured_content.unwrap(),
            json!({"code":"synthetic","error":"Public message","status":status.as_u16()})
        );
    }
    // A successful HTTP status cannot establish a known write result if its
    // public envelope cannot be read. Never turn this into a retryable success.
    for body in [
        Body::from("invalid json"),
        Body::from(" ".repeat(8 * 1024 * 1024 + 1)),
    ] {
        let result = forms_result((StatusCode::OK, body).into_response()).await;
        assert_eq!(result.is_error, Some(true));
        let value = result.structured_content.unwrap();
        assert_eq!(value["code"], "forms_result_unavailable");
        assert_eq!(value["status"], 200);
        assert!(value["error"].as_str().unwrap().contains("Reconcile"));
    }
}

#[tokio::test]
async fn forms_save_payload_bound_rejects_before_upstream() {
    let (origin, seen, task) = fixture().await;
    let result = call(
        app(server(&origin, [true; 3], true)),
        "save_website_form",
        json!({"website_id":SITE,"form":{"form_key":"contact","name":"Contact",
            "fields":[{"label":"x".repeat(crate::form_save::MAX_SAVE_BYTES)}],"active":false}}),
        Some(OWNER),
        true,
    )
    .await;
    assert_eq!(result["result"]["isError"], true);
    assert_eq!(
        result["result"]["structuredContent"]["code"],
        "invalid_request"
    );
    assert_eq!(result["result"]["structuredContent"]["status"], 400);
    assert!(seen.lock().unwrap().is_empty());
    task.abort();
}

#[tokio::test]
async fn forms_discovery_is_configuration_scoped_not_session_identity() {
    let service = app(server("http://127.0.0.1:1", [true; 3], true));
    let owner = rpc(service.clone(), "tools/list", json!({}), Some(OWNER), true).await;
    let other = rpc(
        service,
        "tools/list",
        json!({}),
        Some(Uuid::from_u128(99)),
        true,
    )
    .await;
    assert_eq!(owner["result"]["tools"], other["result"]["tools"]);
    assert!(
        other["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "save_website_form")
    );
}

#[tokio::test]
async fn secured_transport_caps_request_body_before_dispatch() {
    let service = secured_service(crate::websites::WebsiteStore::new(
        "http://127.0.0.1:1",
        "synthetic-publishable",
    ));
    let response = Router::new()
        .nest_service("/mcp", service)
        .oneshot(
            Request::post("/mcp")
                .header("host", "localhost")
                .header("content-type", "application/json")
                .header("accept", "application/json, text/event-stream")
                .header("mcp-protocol-version", "2025-11-25")
                .body(Body::from(" ".repeat(32 * 1024 * 1024 + 1)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}
