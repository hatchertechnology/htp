//! Synthetic tests for the profile-1.4 lifecycle and remediation reads: no JWT
//! construction, hosted endpoints or provider calls.
use super::*;
use axum::{Json, Router, http::HeaderMap, routing::post};
use rmcp::handler::server::{tool::Extension, wrapper::Parameters};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

const SITE: uuid::Uuid = uuid::Uuid::from_u128(1);
const RUN: uuid::Uuid = uuid::Uuid::from_u128(2);
const ENTITY: &str = "sha256:a65188fd4468979beec6d2bf886243983bb484ae6e3cd81ad9f3a0cb7fd6537f";
type Seen = Arc<Mutex<Vec<(String, Value, String)>>>;

struct Fixture {
    mcp: WebsiteMcp,
    seen: Seen,
    hits: Arc<AtomicUsize>,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

fn rpc_route(
    name: &'static str,
    seen: Seen,
    hits: Arc<AtomicUsize>,
    reply: Value,
    status: u16,
) -> Router {
    Router::new().route(
        &format!("/rest/v1/rpc/{name}"),
        post(move |headers: HeaderMap, Json(body): Json<Value>| {
            let (seen, hits, reply) = (seen.clone(), hits.clone(), reply.clone());
            async move {
                hits.fetch_add(1, Ordering::SeqCst);
                let auth = headers["authorization"].to_str().unwrap().to_owned();
                seen.lock().unwrap().push((name.to_owned(), body, auth));
                (
                    axum::http::StatusCode::from_u16(status).unwrap(),
                    Json(reply),
                )
            }
        }),
    )
}

async fn fixture(
    capabilities: crate::RolloutCapabilities,
    status: u16,
    lifecycle: Value,
    remediation: Value,
) -> Fixture {
    let seen: Seen = Arc::default();
    let hits = Arc::new(AtomicUsize::new(0));
    let upstream = rpc_route(
        "seosmith_lifecycle_history",
        seen.clone(),
        hits.clone(),
        lifecycle.clone(),
        status,
    )
    .merge(rpc_route(
        "seosmith_url_lifecycle_history",
        seen.clone(),
        hits.clone(),
        lifecycle,
        status,
    ))
    .merge(rpc_route(
        "seosmith_remediation_list",
        seen.clone(),
        hits.clone(),
        remediation,
        status,
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let store = crate::websites::WebsiteStore::new(&origin, "synthetic-publishable");
    let mcp = WebsiteMcp {
        store: store.clone(),
        forms: crate::form_verification::FormVerificationState {
            verifier: crate::form_verification::FormVerifier::new(&origin, "t"),
            enabled: false,
        },
        inbox: crate::form_inbox::FormInboxState {
            reader: crate::form_inbox::FormInboxReader::new(&origin, "t"),
            enabled: false,
            pilot: None,
        },
        save: crate::form_save::state_from_env(crate::form_save::FormSaver::new(&origin, "t")),
        responses: crate::form_responses::state_from_env(
            crate::form_responses::ResponseWriter::new(&origin, "t"),
        ),
        tool_router: website_tool_router(false),
        // The same composition `secured_service_with` builds for lifecycle and remediation.
        management: crate::seosmith::read_router(store).layer(
            axum::middleware::from_fn_with_state(capabilities, crate::rollout_gate),
        ),
        exports: Arc::default(),
    };
    Fixture {
        mcp,
        seen,
        hits,
        server,
    }
}

fn parts(token: Option<&str>) -> axum::http::request::Parts {
    let mut request = axum::http::Request::builder();
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    request.body(()).unwrap().into_parts().0
}
fn all_on() -> crate::RolloutCapabilities {
    crate::RolloutCapabilities {
        lifecycle: true,
        remediation: true,
        ..Default::default()
    }
}

async fn call_all(f: &Fixture, token: Option<&str>) -> [CallToolResult; 3] {
    [
        f.mcp
            .website_audit_lifecycle(
                Parameters(LifecycleInput {
                    website_id: SITE,
                    entity_id: ENTITY.into(),
                    rule: "missing_title".into(),
                    limit: None,
                    before: None,
                    before_id: None,
                }),
                Extension(parts(token)),
            )
            .await,
        f.mcp
            .website_url_lifecycle(
                Parameters(UrlLifecycleInput {
                    website_id: SITE,
                    entity_id: ENTITY.into(),
                    limit: None,
                    before: None,
                    before_id: None,
                }),
                Extension(parts(token)),
            )
            .await,
        f.mcp
            .website_remediation_list(
                Parameters(RemediationListInput {
                    website_id: SITE,
                    delivery_id: RUN,
                    finding_index: 0,
                    before: None,
                    before_id: None,
                }),
                Extension(parts(token)),
            )
            .await,
    ]
}

#[tokio::test]
async fn held_flags_return_unavailable_and_never_reach_the_database() {
    for capabilities in [
        crate::RolloutCapabilities::default(),
        // Each flag holds only its own tools.
        crate::RolloutCapabilities {
            lifecycle: true,
            ..Default::default()
        },
        crate::RolloutCapabilities {
            remediation: true,
            ..Default::default()
        },
    ] {
        let f = fixture(
            capabilities,
            200,
            json!({"version":1,"items":[]}),
            json!([]),
        )
        .await;
        let results = call_all(&f, Some("owner-token")).await;
        let held = [
            !capabilities.lifecycle,
            !capabilities.lifecycle,
            !capabilities.remediation,
        ];
        for (result, held) in results.iter().zip(held) {
            let value = result.structured_content.as_ref().unwrap();
            if held {
                assert_eq!(result.is_error, Some(true));
                assert_eq!(value["code"], "unavailable");
                assert_eq!(value["status"], 503);
                assert!(value.get("items").is_none(), "held is never an empty page");
            } else {
                assert_eq!(result.is_error, Some(false));
            }
        }
        let enabled = held.iter().filter(|held| !**held).count();
        assert_eq!(f.hits.load(Ordering::SeqCst), enabled);
    }
}

#[tokio::test]
async fn enabled_reads_forward_the_owner_jwt_and_keyset_cursor() {
    let page = json!({"version":1,"entity_id":ENTITY,"rule":"missing_title","items":[{"delivery_id":"d"}],"has_more":true,
        "next_cursor":{"before":"2026-11-20T00:00:00+00:00","before_id":"00000000-0000-0000-0000-000000000009"}});
    let f = fixture(all_on(), 200, page.clone(), json!([])).await;
    let cursor_id = uuid::Uuid::from_u128(9);
    let result = f
        .mcp
        .website_audit_lifecycle(
            Parameters(LifecycleInput {
                website_id: SITE,
                entity_id: ENTITY.into(),
                rule: "missing_title".into(),
                limit: Some(1),
                before: Some("2026-11-21T00:00:00Z".into()),
                before_id: Some(cursor_id),
            }),
            Extension(parts(Some("owner-token"))),
        )
        .await;
    assert_eq!(result.is_error, Some(false));
    assert_eq!(
        result.structured_content.unwrap(),
        page,
        "the RPC page is returned untouched"
    );
    let result = f
        .mcp
        .website_url_lifecycle(
            Parameters(UrlLifecycleInput {
                website_id: SITE,
                entity_id: ENTITY.into(),
                limit: None,
                before: None,
                before_id: None,
            }),
            Extension(parts(Some("owner-token"))),
        )
        .await;
    assert_eq!(result.is_error, Some(false));
    let seen = f.seen.lock().unwrap();
    let (name, body, auth) = &seen[0];
    assert_eq!(name, "seosmith_lifecycle_history");
    assert_eq!(auth, "Bearer owner-token");
    assert_eq!(body["p_website_id"], SITE.to_string());
    assert_eq!(body["p_entity_id"], ENTITY);
    assert_eq!(body["p_rule"], "missing_title");
    assert_eq!(body["p_limit"], 1);
    assert_eq!(body["p_before"], "2026-11-21T00:00:00Z");
    assert_eq!(body["p_before_id"], cursor_id.to_string());
    let (name, body, _) = &seen[1];
    assert_eq!(name, "seosmith_url_lifecycle_history");
    assert_eq!(body["p_limit"], 50, "the REST default applies");
    assert!(body["p_before"].is_null() && body["p_before_id"].is_null());
}

#[tokio::test]
async fn a_nonowner_is_denied_without_rows_and_a_missing_token_is_unauthorized() {
    let f = fixture(
        all_on(),
        403,
        json!({"message":"PRIVATE DATABASE DETAIL","items":[1]}),
        json!({"message":"PRIVATE DATABASE DETAIL"}),
    )
    .await;
    for result in call_all(&f, Some("other-owner-token")).await {
        assert_eq!(result.is_error, Some(true));
        let value = result.structured_content.unwrap();
        assert_eq!(value["status"], 403);
        assert!(!value.to_string().contains("PRIVATE DATABASE DETAIL"));
        assert!(value.get("items").is_none());
    }
    let before = f.hits.load(Ordering::SeqCst);
    for result in call_all(&f, None).await {
        assert_eq!(result.is_error, Some(true));
        assert_eq!(result.structured_content.unwrap()["code"], "unauthorized");
    }
    assert_eq!(
        f.hits.load(Ordering::SeqCst),
        before,
        "no token, no database call"
    );
}

#[tokio::test]
async fn remediation_is_wrapped_as_a_page_with_an_attempt_cursor() {
    let attempts: Vec<Value> = (0..50)
        .map(|n| json!({"id":format!("00000000-0000-0000-0000-{:012}", 100 - n),"created_at":format!("2026-11-20T00:{:02}:00+00:00", 59 - n)}))
        .collect();
    let last = attempts.last().unwrap().clone();
    let reply = json!([{"id":"w","status":"open","attempts":attempts,"attempts_more":true}]);
    let f = fixture(all_on(), 200, json!({}), reply).await;
    let before_id = uuid::Uuid::from_u128(5);
    let result = f
        .mcp
        .website_remediation_list(
            Parameters(RemediationListInput {
                website_id: SITE,
                delivery_id: RUN,
                finding_index: 3,
                before: Some("2026-11-21T00:00:00Z".into()),
                before_id: Some(before_id),
            }),
            Extension(parts(Some("owner-token"))),
        )
        .await;
    assert_eq!(result.is_error, Some(false));
    let value = result.structured_content.unwrap();
    assert_eq!(value["version"], 1);
    assert_eq!(value["delivery_id"], RUN.to_string());
    assert_eq!(value["finding_index"], 3);
    assert_eq!(value["has_more"], true);
    assert_eq!(
        value["next_cursor"],
        json!({"before":last["created_at"],"before_id":last["id"]})
    );
    assert_eq!(value["items"][0]["status"], "open");
    let seen = f.seen.lock().unwrap();
    let (name, body, auth) = &seen[0];
    assert_eq!(name, "seosmith_remediation_list");
    assert_eq!(auth, "Bearer owner-token");
    assert_eq!(body["p_delivery_id"], RUN.to_string());
    assert_eq!(body["p_finding_index"], 3);
    assert_eq!(body["p_before"], "2026-11-21T00:00:00Z");
    assert_eq!(body["p_before_id"], before_id.to_string());
}

#[test]
fn remediation_page_has_no_cursor_when_attempts_are_complete_or_empty() {
    for items in [json!([]), json!([{"attempts":[],"attempts_more":false}])] {
        let page = remediation_page(RUN, 0, &items);
        assert_eq!(page["has_more"], false);
        assert!(page["next_cursor"].is_null());
    }
}

#[test]
fn the_three_reads_are_listed_read_only_with_the_persisted_cursor_fields() {
    let tools = website_tool_router(false).list_all();
    for name in [
        "website_audit_lifecycle",
        "website_url_lifecycle",
        "website_remediation_list",
    ] {
        let tool = tools
            .iter()
            .find(|tool| tool.name == name)
            .unwrap_or_else(|| panic!("{name} listed"));
        let annotations = tool.annotations.as_ref().unwrap();
        assert_eq!(annotations.read_only_hint, Some(true));
        assert_eq!(annotations.destructive_hint, Some(false));
        assert_eq!(annotations.idempotent_hint, Some(true));
        let schema = serde_json::to_string(&tool.input_schema).unwrap();
        assert!(
            schema.contains("before_id") && !schema.contains("beforeId"),
            "{name}: {schema}"
        );
    }
}
