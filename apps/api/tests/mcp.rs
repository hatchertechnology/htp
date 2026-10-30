use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use tower::ServiceExt;

#[tokio::test]
async fn official_sdk_client_can_discover_and_call_tools() {
    use rmcp::{
        ServiceExt as _,
        model::{CallToolRequestParams, ClientConfig},
        transport::StreamableHttpClientTransport,
    };

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, htp_api::app()).await });

    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let transport = StreamableHttpClientTransport::from_uri(endpoint);
        let client = ClientConfig::default().serve(transport).await.unwrap();
        let tools = client.list_tools(None).await.unwrap();
        assert_eq!(tools.tools.len(), 1);
        assert_eq!(tools.tools[0].name, "hello_world");
        let result = client
            .call_tool(CallToolRequestParams::new("hello_world"))
            .await
            .unwrap();
        assert_eq!(
            result.structured_content,
            Some(json!({"message": "hello world"}))
        );
        client.cancel().await.unwrap();
    })
    .await
    .expect("MCP client lifecycle timed out");
    server.abort();
}

async fn rpc(body: Value) -> Value {
    let response = htp_api::app()
        .oneshot(
            Request::post("/mcp")
                .header("host", "localhost")
                .header("content-type", "application/json")
                .header("accept", "application/json, text/event-stream")
                .header("mcp-protocol-version", "2025-11-25")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "application/json");
    assert!(!response.headers().contains_key("mcp-session-id"));
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn initializes_and_advertises_tools() {
    let initialized = rpc(json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": {"name": "htp-test", "version": "1.0.0"}
        }
    }))
    .await;
    assert_eq!(initialized["id"], 1);
    assert_eq!(initialized["result"]["serverInfo"]["name"], "htp-api");
    assert!(initialized["result"]["capabilities"]["tools"].is_object());

    let tools = rpc(json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})).await;
    assert_eq!(tools["result"]["tools"][0]["name"], "hello_world");
    assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn tool_returns_the_same_message_as_rest() {
    let result = rpc(json!({
        "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": {"name": "hello_world", "arguments": {}}
    }))
    .await;
    assert_eq!(result["result"]["isError"], false);

    let rest = htp_api::app()
        .oneshot(Request::get("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(rest.status(), StatusCode::OK);
    let bytes = to_bytes(rest.into_body(), 1024).await.unwrap();
    let message: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(message, json!({"message": "hello world"}));
    assert_eq!(result["result"]["structuredContent"], message);
    let text: Value =
        serde_json::from_str(result["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(text, message);
}

#[tokio::test]
async fn unknown_tools_return_a_protocol_error() {
    let result = rpc(json!({
        "jsonrpc": "2.0", "id": 4, "method": "tools/call",
        "params": {"name": "missing", "arguments": {}}
    }))
    .await;
    assert_eq!(result["id"], 4);
    assert!(result["error"].is_object());
}

#[tokio::test]
async fn rejects_untrusted_hosts_and_origins() {
    for (host, origin) in [
        ("attacker.example", "http://localhost:3000"),
        ("localhost", "https://attacker.example"),
    ] {
        let response = htp_api::app()
            .oneshot(
                Request::post("/mcp")
                    .header("host", host)
                    .header("origin", origin)
                    .header("content-type", "application/json")
                    .header("accept", "application/json, text/event-stream")
                    .body(Body::from(
                        r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
