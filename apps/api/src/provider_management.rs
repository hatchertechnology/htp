//! Native owner operations. Never return grant material or upstream error bodies.
use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
    response::IntoResponse,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::time::Duration;

const SEARCH: &str = "https://www.googleapis.com/auth/webmasters.readonly";
const ANALYTICS: &str = "https://www.googleapis.com/auth/analytics.readonly";
const BUSINESS: &str = "https://www.googleapis.com/auth/business.manage";
pub(crate) fn enabled() -> bool {
    std::env::var("HTP_ROLLOUT_PROVIDER_OAUTH").as_deref() == Ok("true")
}
fn env(name: &str) -> Result<String, u16> {
    std::env::var(name)
        .ok()
        .filter(|v| !v.is_empty())
        .ok_or(503)
}
struct Store {
    project: String,
    service: String,
    client: reqwest::Client,
}
impl Store {
    fn load() -> Result<Self, u16> {
        Ok(Self {
            project: env("SUPABASE_URL")?,
            service: env("SUPABASE_SERVICE_ROLE_KEY")?,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(15))
                .build()
                .map_err(|_| 503u16)?,
        })
    }
    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, u16> {
        let mut request = self
            .client
            .request(method, format!("{}/rest/v1/{path}", self.project))
            .header("apikey", &self.service)
            .bearer_auth(&self.service)
            .header(
                "prefer",
                "resolution=merge-duplicates,return=representation",
            );
        if let Some(body) = body {
            request = request.json(&body);
        }
        bounded(request.send().await.map_err(|_| 503u16)?, 503).await
    }
    async fn read(&self, name: &str, owner: uuid::Uuid) -> Result<Value, u16> {
        let rows = self
            .request(
                reqwest::Method::GET,
                &format!("{name}_connections?owner_id=eq.{owner}&select=*"),
                None,
            )
            .await?;
        let rows = rows.as_array().ok_or(503u16)?;
        if rows.len() > 1 {
            return Err(503);
        }
        Ok(rows.first().cloned().unwrap_or(Value::Null))
    }
}
async fn bounded(mut response: reqwest::Response, error: u16) -> Result<Value, u16> {
    if !response.status().is_success() {
        return Err(error);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| error)? {
        if bytes.len() + chunk.len() > 65536 {
            return Err(error);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| error)
}
async fn owner(headers: &HeaderMap) -> Result<uuid::Uuid, u16> {
    let token =
        crate::auth::bearer_token(headers).map_err(|e| e.into_response().status().as_u16())?;
    crate::auth::SupabaseAuth::new(&env("SUPABASE_URL")?)
        .verify(token)
        .await
        .map(|u| u.id)
        .map_err(|e| e.into_response().status().as_u16())
}
fn configured(name: &str) -> bool {
    let prefix = name.to_uppercase();
    [
        format!("{prefix}_CLIENT_ID"),
        format!("{prefix}_CLIENT_SECRET"),
        format!("{prefix}_COOKIE_KEY"),
        "SUPABASE_SERVICE_ROLE_KEY".into(),
    ]
    .iter()
    .all(|v| env(v).is_ok())
}
fn status(name: &str, configured: bool, row: &Value) -> Value {
    let connected = row.is_object() && row["status"] != "disconnected";
    let reauth = row["status"] == "reauthorization_required";
    if name == "bing" {
        return json!({"configured":configured,"connected":connected,"reauthorizationRequired":reauth});
    }
    let has = |scope: &str| {
        row["scopes"]
            .as_array()
            .is_some_and(|s| s.iter().any(|v| v == scope))
    };
    json!({"configured":configured,"connected":connected,"analytics":has(ANALYTICS),"search":has(SEARCH),"business":has(BUSINESS),"reauthorizationRequired":reauth})
}
pub(crate) async fn connection(
    headers: &HeaderMap,
    name: &str,
    disconnect: bool,
) -> Result<Value, u16> {
    let owner = owner(headers).await?;
    if !disconnect && !configured(name) {
        return Ok(status(name, false, &Value::Null));
    }
    if name == "bing" && !configured(name) {
        return Err(503);
    }
    let store = Store::load()?;
    if !disconnect {
        return Ok(status(name, true, &store.read(name, owner).await?));
    }
    let row = tombstone(name, owner);
    store
        .request(
            reqwest::Method::POST,
            &format!("{name}_connections"),
            Some(row),
        )
        .await?;
    Ok(json!({"connected":false}))
}
fn tombstone(name: &str, owner: uuid::Uuid) -> Value {
    let mut row = json!({"owner_id":owner,"generation":uuid::Uuid::new_v4(),"encrypted_grant":"","status":"disconnected","updated_at":chrono::Utc::now().to_rfc3339()});
    if name == "google" {
        row["scopes"] = json!([]);
    }
    row
}

async fn access(store: &Store, owner: uuid::Uuid) -> Result<String, u16> {
    if !configured("google") {
        return Err(503);
    }
    let key = STANDARD
        .decode(env("GOOGLE_COOKIE_KEY")?)
        .map_err(|_| 503u16)?;
    access_at(
        store,
        owner,
        &key,
        &env("GOOGLE_CLIENT_ID")?,
        &env("GOOGLE_CLIENT_SECRET")?,
        "https://oauth2.googleapis.com/token",
    )
    .await
}
async fn access_at(
    store: &Store,
    owner: uuid::Uuid,
    key: &[u8],
    client_id: &str,
    client_secret: &str,
    endpoint: &str,
) -> Result<String, u16> {
    if key.len() != 32 {
        return Err(503);
    }
    let row = store.read("google", owner).await?;
    if row["status"] != "connected" {
        return Err(401);
    }
    let purpose = format!("htp_google_grant:{owner}");
    let grant = crate::provider_oauth::unseal(
        row["encrypted_grant"].as_str().ok_or(401u16)?,
        key,
        &purpose,
    )
    .ok_or(401u16)?;
    if grant["user"] != owner.to_string() {
        return Err(401);
    }
    let refresh = grant["refresh"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or(401u16)?;
    if !grant["scopes"]
        .as_array()
        .is_some_and(|s| s.iter().any(|v| v == SEARCH))
    {
        return Err(403);
    }
    let body = form_urlencoded::Serializer::new(String::new())
        .extend_pairs([
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh),
            ("client_id", client_id),
            ("client_secret", client_secret),
        ])
        .finish();
    let tokens = bounded(
        store
            .client
            .post(endpoint)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(|_| 401u16)?,
        401,
    )
    .await?;
    let access = tokens["access_token"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or(401u16)?;
    if let Some(rotated) = tokens["refresh_token"]
        .as_str()
        .filter(|v| !v.is_empty() && *v != refresh)
    {
        let encrypted = crate::provider_oauth::seal(
            &json!({"user":owner,"refresh":rotated,"scopes":grant["scopes"]}),
            key,
            &purpose,
        )
        .map_err(|()| 401u16)?;
        store.request(reqwest::Method::POST,"rpc/rotate_google_grant",Some(json!({"p_owner_id":owner,"p_generation":row["generation"],"p_encrypted_grant":encrypted}))).await.map_err(|_|401u16)?;
    }
    Ok(access.into())
}
pub(crate) async fn inspect(
    headers: &HeaderMap,
    id: uuid::Uuid,
    site_url: String,
    url: String,
) -> Result<Value, u16> {
    let owner = owner(headers).await?;
    let store = Store::load()?;
    let websites =
        crate::websites::WebsiteStore::new(&store.project, &env("SUPABASE_PUBLISHABLE_KEY")?);
    // Check ownership before touching credentials or Google.
    let website = websites
        .find(id, headers)
        .await
        .map_err(|e| e.into_response().status().as_u16())?;
    crate::search::normalized_inspection(&url, &site_url, &website.fqdn).ok_or(400u16)?;
    let token = access(&store, owner).await?;
    let mut headers = headers.clone();
    headers.insert("x-google-access-token", token.parse().map_err(|_| 401u16)?);
    crate::search::inspect(
        State((websites, crate::search::SearchClient::default())),
        Path(id),
        headers,
        Json(crate::search::UrlInput { site_url, url }),
    )
    .await
    .map(|Json(v)| v)
    .map_err(|e| e.into_response().status().as_u16())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn synthetic_refresh_uses_owner_aad_and_original_generation() {
        use axum::{Router, http::Uri, routing::any};
        use std::sync::{Arc, Mutex};
        let owner = uuid::Uuid::new_v4();
        let generation = uuid::Uuid::new_v4();
        let key = [7u8; 32];
        let grant = crate::provider_oauth::seal(
            &json!({"user":owner,"refresh":"synthetic+refresh&","scopes":[SEARCH]}),
            &key,
            &format!("htp_google_grant:{owner}"),
        )
        .unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let captured = seen.clone();
        let app=Router::new().fallback(any(move |uri:Uri, headers:HeaderMap, body:String| {
            let grant=grant.clone(); let seen=captured.clone();
            async move {
                seen.lock().unwrap().push((uri.to_string(),body.clone()));
                if uri.path()=="/token" {
                    assert_eq!(headers["content-type"],"application/x-www-form-urlencoded");
                    let fields:std::collections::HashMap<_,_>=form_urlencoded::parse(body.as_bytes()).into_owned().collect();
                    assert_eq!(fields["refresh_token"],"synthetic+refresh&");
                    return Json(json!({"access_token":"request-local-access","refresh_token":"rotated-refresh"}));
                }
                assert_eq!(headers["authorization"],"Bearer synthetic-service");
                assert_eq!(headers["apikey"],"synthetic-service");
                if uri.path().ends_with("rotate_google_grant") {
                    let value:Value=serde_json::from_str(&body).unwrap();
                    assert_eq!(value["p_owner_id"],owner.to_string());
                    assert_eq!(value["p_generation"],generation.to_string());
                    let rotated=crate::provider_oauth::unseal(value["p_encrypted_grant"].as_str().unwrap(),&key,&format!("htp_google_grant:{owner}")).unwrap();
                    assert_eq!(rotated["refresh"],"rotated-refresh");
                    assert!(rotated.get("access").is_none());
                    // A concurrent disconnect wins the CAS; no unconditional upsert follows.
                    return Json(json!(false));
                }
                assert!(uri.query().unwrap().contains(&format!("owner_id=eq.{owner}")));
                Json(json!([{"generation":generation,"status":"connected","encrypted_grant":grant}]))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let store = Store {
            project: origin.clone(),
            service: "synthetic-service".into(),
            client: reqwest::Client::new(),
        };
        assert_eq!(
            access_at(
                &store,
                owner,
                &key,
                "synthetic-id",
                "synthetic-secret",
                &format!("{origin}/token")
            )
            .await
            .unwrap(),
            "request-local-access"
        );
        assert_eq!(seen.lock().unwrap().len(), 3);
        assert_eq!(
            access_at(
                &store,
                owner,
                &[8; 32],
                "id",
                "secret",
                &format!("{origin}/token")
            )
            .await,
            Err(401)
        );
        assert_eq!(seen.lock().unwrap().len(), 4);
        server.abort();
    }
    #[tokio::test]
    async fn disconnected_wrong_owner_and_missing_search_scope_never_refresh() {
        use axum::{Router, routing::get};
        let owner = uuid::Uuid::new_v4();
        let key = [7; 32];
        for (status, user, scopes, expected) in [
            ("disconnected", owner, vec![SEARCH], 401),
            ("connected", uuid::Uuid::new_v4(), vec![SEARCH], 401),
            ("connected", owner, vec![ANALYTICS], 403),
        ] {
            let encrypted = crate::provider_oauth::seal(
                &json!({"user":user,"refresh":"synthetic","scopes":scopes}),
                &key,
                &format!("htp_google_grant:{owner}"),
            )
            .unwrap();
            let app = Router::new().route(
                "/rest/v1/google_connections",
                get(move || {
                    let encrypted = encrypted.clone();
                    async move { Json(json!([{"status":status,"encrypted_grant":encrypted}])) }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let project = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let store = Store {
                project,
                service: "synthetic".into(),
                client: reqwest::Client::new(),
            };
            // Invalid endpoint ensures a mistaken refresh cannot accidentally pass.
            assert_eq!(
                access_at(&store, owner, &key, "id", "secret", "invalid://never").await,
                Err(expected)
            );
            server.abort();
        }
    }
    #[tokio::test]
    async fn native_operations_reject_missing_identity_before_configuration() {
        assert_eq!(
            connection(&HeaderMap::new(), "google", false).await,
            Err(401)
        );
        assert_eq!(connection(&HeaderMap::new(), "bing", true).await, Err(401));
        assert_eq!(
            inspect(
                &HeaderMap::new(),
                uuid::Uuid::new_v4(),
                "sc-domain:example.com".into(),
                "https://example.com/".into()
            )
            .await,
            Err(401)
        );
    }
    #[tokio::test]
    async fn synthetic_store_fails_closed_on_error_redirect_and_oversize() {
        use axum::{Router, http::StatusCode, routing::get};
        let app = Router::new()
            .route(
                "/error",
                get(|| async { (StatusCode::FORBIDDEN, "PRIVATE") }),
            )
            .route(
                "/redirect",
                get(|| async { axum::response::Redirect::temporary("/error") }),
            )
            .route("/large", get(|| async { "x".repeat(65537) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        for path in ["error", "redirect", "large"] {
            assert_eq!(
                bounded(
                    client.get(format!("{origin}/{path}")).send().await.unwrap(),
                    503
                )
                .await,
                Err(503)
            );
        }
        server.abort();
    }
    #[test]
    fn disconnect_changes_generation_and_clears_grant() {
        let owner = uuid::Uuid::new_v4();
        for name in ["google", "bing"] {
            let a = tombstone(name, owner);
            let b = tombstone(name, owner);
            assert_eq!(a["owner_id"], owner.to_string());
            assert_eq!(a["status"], "disconnected");
            assert_eq!(a["encrypted_grant"], "");
            assert_ne!(a["generation"], b["generation"]);
            if name == "google" {
                assert_eq!(a["scopes"], json!([]));
            }
        }
    }
    #[test]
    fn metadata_preserves_nitro_status_and_privacy() {
        let row = json!({"status":"reauthorization_required","scopes":[SEARCH],"encrypted_grant":"PRIVATE","generation":"PRIVATE"});
        assert_eq!(
            status("google", true, &row),
            json!({"configured":true,"connected":true,"analytics":false,"search":true,"business":false,"reauthorizationRequired":true})
        );
        assert_eq!(
            status("bing", true, &json!({"status":"disconnected"})),
            json!({"configured":true,"connected":false,"reauthorizationRequired":false})
        );
        assert_eq!(status("google", false, &Value::Null)["connected"], false);
    }
}
