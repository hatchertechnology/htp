//! Closed owner facades for the seven existing Independent Audit RPCs.
//! Database ownership, pilot scope and held grants remain authoritative.
use crate::websites::{WebsiteError, WebsiteStore};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, header},
    response::{IntoResponse, Response},
    routing::{delete, get},
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

pub(crate) fn router(store: WebsiteStore) -> Router {
    Router::new()
        .route(
            "/websites/{id}/independent-audits",
            get(history).post(import),
        )
        .route("/websites/{id}/independent-audits/{item}", get(detail))
        .route(
            "/websites/{id}/independent-comparisons",
            get(comparisons).post(save),
        )
        .route(
            "/websites/{id}/independent-comparisons/{item}",
            get(comparison_detail),
        )
        .route(
            "/websites/{id}/independent-evidence/fingerprint",
            get(fingerprint),
        )
        .route("/websites/{id}/independent-evidence", delete(remove))
        // JSON escaping can expand each raw source byte sixfold. The source limit
        // is checked after decoding, never against the encoded envelope.
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        .with_state(store)
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    before: Option<String>,
    before_id: Option<Uuid>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Import {
    format: String,
    source: String,
    metadata: serde_json::Map<String, Value>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Save {
    import_id: Uuid,
    delivery_id: Uuid,
    asserted: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Removal {
    confirmation: String,
    export_fingerprint: String,
}
fn respond(result: Result<Value, WebsiteError>) -> Response {
    let mut response = match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.into_response(),
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}
async fn history(
    State(store): State<WebsiteStore>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(q): Query<Cursor>,
) -> Response {
    respond(store.rpc(&headers, "independent_audit_history", json!({"p_website_id":id,"p_id":null,"p_before":q.before,"p_before_id":q.before_id})).await)
}
async fn detail(
    State(store): State<WebsiteStore>,
    headers: HeaderMap,
    Path((id, item)): Path<(Uuid, Uuid)>,
) -> Response {
    respond(
        store
            .rpc(
                &headers,
                "independent_audit_history",
                json!({"p_website_id":id,"p_id":item}),
            )
            .await,
    )
}
async fn comparisons(
    State(store): State<WebsiteStore>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(q): Query<Cursor>,
) -> Response {
    respond(
        store
            .rpc(
                &headers,
                "independent_comparison_history",
                json!({"p_website_id":id,"p_before":q.before,"p_before_id":q.before_id}),
            )
            .await,
    )
}
async fn comparison_detail(
    State(store): State<WebsiteStore>,
    headers: HeaderMap,
    Path((id, item)): Path<(Uuid, Uuid)>,
) -> Response {
    respond(
        store
            .rpc(
                &headers,
                "independent_comparison_detail",
                json!({"p_website_id":id,"p_comparison_id":item}),
            )
            .await,
    )
}
async fn fingerprint(
    State(store): State<WebsiteStore>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Response {
    respond(
        store
            .rpc(
                &headers,
                "independent_evidence_fingerprint",
                json!({"p_website_id":id}),
            )
            .await,
    )
}
async fn import(
    State(store): State<WebsiteStore>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Import>,
) -> Response {
    if body.source.is_empty() || body.source.len() > 4_194_304 {
        return respond(Err(WebsiteError::Invalid("invalid_import")));
    }
    respond(store.rpc(&headers, "import_independent_audit", json!({"p_website_id":id,"p_format":body.format,"p_source":body.source,"p_metadata":body.metadata})).await)
}
async fn save(
    State(store): State<WebsiteStore>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Save>,
) -> Response {
    respond(store.rpc(&headers, "save_independent_comparison", json!({"p_website_id":id,"p_import_id":body.import_id,"p_delivery_id":body.delivery_id,"p_asserted":body.asserted})).await)
}
async fn remove(
    State(store): State<WebsiteStore>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Removal>,
) -> Response {
    if body.confirmation != "DELETE INDEPENDENT EVIDENCE" {
        return respond(Err(WebsiteError::Invalid("confirmation_required")));
    }
    // Never replace or normalize the caller's export proof. The RPC compares it
    // while holding the website lock and serializes imports/saves/removal.
    respond(store.rpc(&headers, "delete_independent_audit_evidence", json!({"p_website_id":id,"p_confirmation":body.confirmation,"p_export_fingerprint":body.export_fingerprint})).await)
}

pub(crate) fn is_rpc(name: &str) -> bool {
    matches!(
        name,
        "independent_audit_history"
            | "independent_comparison_history"
            | "independent_comparison_detail"
            | "independent_evidence_fingerprint"
            | "import_independent_audit"
            | "save_independent_comparison"
            | "delete_independent_audit_evidence"
    )
}
// Only known database validation labels are surfaced; arbitrary DB detail is not.
pub(crate) fn validation_message(value: &Value) -> Option<&'static str> {
    if value.get("code")?.as_str()? != "22023" {
        return None;
    }
    match value.get("message")?.as_str()? {
        "invalid_import" => Some("invalid_import"),
        "invalid_csv" => Some("invalid_csv"),
        "csv_field_limit" => Some("csv_field_limit"),
        "csv_row_limit" => Some("csv_row_limit"),
        "csv_key_limit" => Some("csv_key_limit"),
        "duplicate_observation" => Some("duplicate_observation"),
        "invalid_cursor" => Some("invalid_cursor"),
        "invalid_comparison" => Some("invalid_comparison"),
        "confirmation_required" => Some("confirmation_required"),
        "evidence_changed_export_again" => Some("evidence_changed_export_again"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        extract::Request,
        middleware,
        routing::any,
    };
    use axum::{http::StatusCode, routing::post};
    use tower::ServiceExt;
    const ID: &str = "00000000-0000-0000-0000-000000000001";
    async fn call(app: Router, path: &str, method: &str, body: Value) -> Response {
        app.oneshot(
            Request::builder()
                .uri(path)
                .method(method)
                .header(header::AUTHORIZATION, "Bearer synthetic-owner")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
    }
    async fn fixture(
        reply: Value,
        status: StatusCode,
    ) -> (
        Router,
        tokio::sync::mpsc::UnboundedReceiver<(String, Value)>,
        tokio::task::JoinHandle<()>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let upstream = Router::new().route(
            "/rest/v1/rpc/{name}",
            post(
                move |Path(name): Path<String>, headers: HeaderMap, Json(body): Json<Value>| {
                    let tx = tx.clone();
                    let reply = reply.clone();
                    async move {
                        assert_eq!(headers[header::AUTHORIZATION], "Bearer synthetic-owner");
                        assert_eq!(headers["apikey"], "publishable-fixture");
                        tx.send((name, body)).unwrap();
                        (status, Json(reply))
                    }
                },
            ),
        );
        let upstream = upstream.layer(DefaultBodyLimit::max(32 * 1024 * 1024));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        (
            router(WebsiteStore::new(&url, "publishable-fixture")),
            rx,
            task,
        )
    }
    #[tokio::test]
    async fn independent_exact_contracts_and_owner_bearer() {
        let cases = [
            (
                "independent-audits".to_owned(),
                "GET",
                json!(null),
                "independent_audit_history",
                json!({"p_website_id":ID,"p_id":null,"p_before":null,"p_before_id":null}),
            ),
            (
                format!("independent-audits?before=2026-01-01&before_id={ID}"),
                "GET",
                json!(null),
                "independent_audit_history",
                json!({"p_website_id":ID,"p_id":null,"p_before":"2026-01-01","p_before_id":ID}),
            ),
            (
                format!("independent-audits/{ID}"),
                "GET",
                json!(null),
                "independent_audit_history",
                json!({"p_website_id":ID,"p_id":ID}),
            ),
            (
                "independent-comparisons".to_owned(),
                "GET",
                json!(null),
                "independent_comparison_history",
                json!({"p_website_id":ID,"p_before":null,"p_before_id":null}),
            ),
            (
                format!("independent-comparisons/{ID}"),
                "GET",
                json!(null),
                "independent_comparison_detail",
                json!({"p_website_id":ID,"p_comparison_id":ID}),
            ),
            (
                "independent-evidence/fingerprint".to_owned(),
                "GET",
                json!(null),
                "independent_evidence_fingerprint",
                json!({"p_website_id":ID}),
            ),
            (
                "independent-audits".to_owned(),
                "POST",
                json!({"format":"controlled-csv-v1","source":"\u{feff}url,rule,state\r\n\"é\",x,unknown\r\n","metadata":{"provenance":"legacy"}}),
                "import_independent_audit",
                json!({"p_website_id":ID,"p_format":"controlled-csv-v1","p_source":"\u{feff}url,rule,state\r\n\"é\",x,unknown\r\n","p_metadata":{"provenance":"legacy"}}),
            ),
            (
                "independent-comparisons".to_owned(),
                "POST",
                json!({"import_id":ID,"delivery_id":ID,"asserted":false}),
                "save_independent_comparison",
                json!({"p_website_id":ID,"p_import_id":ID,"p_delivery_id":ID,"p_asserted":false}),
            ),
            (
                "independent-evidence".to_owned(),
                "DELETE",
                json!({"confirmation":"DELETE INDEPENDENT EVIDENCE","export_fingerprint":"exact-proof"}),
                "delete_independent_audit_evidence",
                json!({"p_website_id":ID,"p_confirmation":"DELETE INDEPENDENT EVIDENCE","p_export_fingerprint":"exact-proof"}),
            ),
        ];
        for (path, method, body, rpc, args) in cases {
            // JSON null is a successful missing detail, never an HTTP 404.
            let (app, mut rx, task) = fixture(Value::Null, StatusCode::OK).await;
            let response = call(app, &format!("/websites/{ID}/{path}"), method, body).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(
                to_bytes(response.into_body(), usize::MAX).await.unwrap(),
                "null"
            );
            assert_eq!(rx.recv().await.unwrap(), (rpc.to_owned(), args));
            task.abort();
        }
    }
    #[tokio::test]
    async fn independent_validation_statuses_and_held_acl() {
        for (status, reply, expected, label) in [
            (
                StatusCode::UNAUTHORIZED,
                json!({}),
                StatusCode::UNAUTHORIZED,
                "session",
            ),
            (
                StatusCode::FORBIDDEN,
                json!({"code":"42501","message":"permission denied"}),
                StatusCode::FORBIDDEN,
                "access",
            ),
            (
                StatusCode::BAD_REQUEST,
                json!({"code":"22023","message":"evidence_changed_export_again"}),
                StatusCode::BAD_REQUEST,
                "evidence_changed_export_again",
            ),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"message":"private detail"}),
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed",
            ),
        ] {
            let (app, mut rx, task) = fixture(reply, status).await;
            let response = call(
                app,
                &format!("/websites/{ID}/independent-evidence/fingerprint"),
                "GET",
                Value::Null,
            )
            .await;
            assert_eq!(response.status(), expected);
            let body = String::from_utf8(
                to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap()
                    .to_vec(),
            )
            .unwrap();
            assert!(body.contains(label));
            assert!(!body.contains("private detail"));
            rx.recv().await.unwrap();
            task.abort();
        }
    }
    #[tokio::test]
    async fn independent_raw_bounds_and_closed_inputs() {
        let (app, mut rx, task) = fixture(json!({}), StatusCode::OK).await;
        // Escaped JSON can exceed 4 MiB while decoded raw bytes stay valid.
        let source = "\u{0001}".repeat(4_194_304);
        let response = call(
            app.clone(),
            &format!("/websites/{ID}/independent-audits"),
            "POST",
            json!({"format":"controlled-csv-v1","source":source,"metadata":{}}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        rx.recv().await.unwrap();
        for source in [String::new(), "é".repeat(2_097_153)] {
            let response = call(
                app.clone(),
                &format!("/websites/{ID}/independent-audits"),
                "POST",
                json!({"format":"controlled-csv-v1","source":source,"metadata":{}}),
            )
            .await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
        for body in [
            json!({"confirmation":"DELETE","export_fingerprint":"proof"}),
            json!({"confirmation":"DELETE INDEPENDENT EVIDENCE"}),
            json!({"confirmation":"DELETE INDEPENDENT EVIDENCE","export_fingerprint":"proof","rpc":"other"}),
        ] {
            assert!(
                call(
                    app.clone(),
                    &format!("/websites/{ID}/independent-evidence"),
                    "DELETE",
                    body
                )
                .await
                .status()
                .is_client_error()
            );
        }
        assert!(rx.try_recv().is_err());
        task.abort();
    }
    #[tokio::test]
    async fn independent_authoritative_rollout_matrix() {
        for resource in [
            "independent-audits".to_owned(),
            format!("independent-audits/{ID}"),
            "independent-comparisons".to_owned(),
            format!("independent-comparisons/{ID}"),
            "independent-evidence/fingerprint".to_owned(),
            "independent-evidence".to_owned(),
        ] {
            for method in ["GET", "POST", "DELETE"] {
                for (write, read) in [(false, false), (true, false), (false, true), (true, true)] {
                    let path = format!("/websites/{ID}/{resource}");
                    let caps = crate::RolloutCapabilities {
                        comparisons: write,
                        comparisons_read_only: read,
                        ..Default::default()
                    };
                    let app = Router::new()
                        .route(&path, any(|| async { "synthetic" }))
                        .layer(middleware::from_fn_with_state(caps, crate::rollout_gate));
                    let expected = if if method == "GET" {
                        write || read
                    } else {
                        write && !read
                    } {
                        StatusCode::OK
                    } else {
                        StatusCode::SERVICE_UNAVAILABLE
                    };
                    assert_eq!(
                        call(app, &path, method, Value::Null).await.status(),
                        expected
                    );
                }
            }
        }
    }
    #[tokio::test]
    async fn independent_full_app_requires_owner_auth_before_gate() {
        let app = crate::app_with_services(
            crate::auth::SupabaseAuth::new("http://127.0.0.1:1"),
            WebsiteStore::new("http://127.0.0.1:1", "synthetic"),
        );
        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!("/websites/{ID}/independent-audits"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
