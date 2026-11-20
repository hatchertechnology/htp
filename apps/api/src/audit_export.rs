use crate::websites::WebsiteStore;
use axum::{
    Router,
    body::Body,
    http::{HeaderMap, Method, Request, StatusCode},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{DateTime, Duration, Utc};
use futures_util::StreamExt as _;
use rmcp::model::CallToolResult;
use rmcp::schemars;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom, Write},
    sync::Arc,
};
use tokio::sync::Mutex;
use tower::ServiceExt as _;
use uuid::Uuid;

const CHUNK: usize = 256 * 1024;
const CAPACITY: u64 = 512 * 1024 * 1024;
const MAX_EXPORTS: usize = 4;

pub(crate) struct Exports {
    entries: HashMap<Uuid, Snapshot>,
    capacity: u64,
}
impl Default for Exports {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            capacity: CAPACITY,
        }
    }
}
struct Snapshot {
    owner: Uuid,
    website: Uuid,
    delivery: Uuid,
    file: std::fs::File,
    bytes: u64,
    hash: String,
    hard: DateTime<Utc>,
    idle: DateTime<Utc>,
}
impl Exports {
    pub(crate) fn reap(&mut self) {
        let now = Utc::now();
        self.entries.retain(|_, e| e.idle > now && e.hard > now);
    }
    fn used(&self) -> u64 {
        self.entries.values().map(|e| e.bytes).sum()
    }
}
pub(crate) type SharedExports = Arc<Mutex<Exports>>;

#[derive(Deserialize, rmcp::schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct StartInput {
    #[schemars(with = "String")]
    pub website_id: Uuid,
    #[schemars(with = "String")]
    pub delivery_id: Uuid,
}
#[allow(clippy::struct_field_names)]
#[derive(Deserialize, rmcp::schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ExportInput {
    #[schemars(with = "String")]
    pub website_id: Uuid,
    #[schemars(with = "String")]
    pub delivery_id: Uuid,
    #[serde(rename = "exportId")]
    #[schemars(with = "String")]
    pub export_id: Uuid,
}
#[derive(Deserialize, rmcp::schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ChunkInput {
    #[schemars(with = "String")]
    pub website_id: Uuid,
    #[schemars(with = "String")]
    pub delivery_id: Uuid,
    #[serde(rename = "exportId")]
    #[schemars(with = "String")]
    pub export_id: Uuid,
    pub offset: u64,
}

pub(crate) fn failure(code: &str, message: &str) -> CallToolResult {
    let mut result = CallToolResult::structured(
        serde_json::json!({"code":code,"exportVersion":1,"message":message}),
    );
    result.is_error = Some(true);
    result
}
async fn authorized(
    store: &WebsiteStore,
    headers: &HeaderMap,
    site: Uuid,
    run: Uuid,
) -> Result<bool, ()> {
    store
        .rpc(
            headers,
            "seosmith_audit_export_access",
            serde_json::json!({"p_website_id":site,"p_delivery_id":run}),
        )
        .await
        .map_err(|_| ())?
        .as_bool()
        .ok_or(())
}
fn descriptor(id: Uuid, e: &Snapshot) -> CallToolResult {
    CallToolResult::structured(
        serde_json::json!({"version":1,"exportId":id,"websiteId":e.website,"deliveryId":e.delivery,
        "representation":"htp.audit-detail-json.v1","byteLength":e.bytes,"sha256":e.hash,"chunkMaxBytes":CHUNK,
        "expiresAt":e.hard.to_rfc3339(),"idleExpiresAt":e.idle.to_rfc3339()}),
    )
}
async fn revoke(cache: &SharedExports, owner: Uuid, website: Uuid, delivery: Uuid) {
    cache
        .lock()
        .await
        .entries
        .retain(|_, e| !(e.owner == owner && e.website == website && e.delivery == delivery));
}
fn expire_idle(e: &mut Snapshot) {
    e.idle = (Utc::now() + Duration::minutes(15)).min(e.hard);
}

// serde_json's IgnoredAny checks JSON grammar without building a token tree,
// but intentionally skips Unicode validation in strings. Validate it separately.
fn valid_unicode(file: &mut std::fs::File) -> std::io::Result<bool> {
    file.seek(SeekFrom::Start(0))?;
    let mut block = vec![0_u8; 65536];
    let (mut in_string, mut escape) = (false, false);
    let (mut digits, mut code, mut need_low) = (0_u8, 0_u16, 0_u8);
    let (mut utf_len, mut utf_need) = (0_usize, 0_usize);
    let mut utf = [0_u8; 4];
    loop {
        let n = file.read(&mut block)?;
        if n == 0 {
            break;
        }
        for &b in &block[..n] {
            if utf_need > 0 {
                utf[utf_len] = b;
                utf_len += 1;
                if utf_len == utf_need {
                    if std::str::from_utf8(&utf[..utf_len]).is_err() {
                        return Ok(false);
                    }
                    utf_len = 0;
                    utf_need = 0;
                }
            } else if b >= 0x80 {
                utf_need = match b {
                    0xc2..=0xdf => 2,
                    0xe0..=0xef => 3,
                    0xf0..=0xf4 => 4,
                    _ => return Ok(false),
                };
                utf[0] = b;
                utf_len = 1;
            }
            if !in_string {
                if b == b'"' {
                    in_string = true;
                }
                continue;
            }
            if digits > 0 {
                let Some(h) = (b as char).to_digit(16) else {
                    return Ok(false);
                };
                code = (code << 4) | u16::try_from(h).expect("hex digit fits u16");
                digits -= 1;
                if digits == 0 {
                    if need_low == 3 {
                        if !(0xdc00..=0xdfff).contains(&code) {
                            return Ok(false);
                        }
                        need_low = 0;
                    } else if (0xd800..=0xdbff).contains(&code) {
                        need_low = 1;
                    } else if (0xdc00..=0xdfff).contains(&code) {
                        return Ok(false);
                    }
                    code = 0;
                }
                continue;
            }
            if need_low == 1 {
                if b != b'\\' {
                    return Ok(false);
                }
                need_low = 2;
                continue;
            }
            if need_low == 2 {
                if b != b'u' {
                    return Ok(false);
                }
                need_low = 3;
                digits = 4;
                continue;
            }
            if escape {
                escape = false;
                if b == b'u' {
                    digits = 4;
                }
                continue;
            }
            if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_string = false;
            }
        }
    }
    Ok(utf_need == 0 && !in_string && digits == 0 && need_low == 0 && !escape)
}

// Memory-backed filesystems charge stored bytes to the machine's memory limit.
#[cfg(target_os = "linux")]
fn disk_backed(file: &std::fs::File) -> bool {
    matches!(rustix::fs::fstatfs(file), Ok(stats) if stats.f_type != 0x0102_1994 && stats.f_type != 0x8584_58f6)
}
#[cfg(not(target_os = "linux"))]
fn disk_backed(_file: &std::fs::File) -> bool {
    false
}

#[allow(clippy::too_many_lines)]
pub(crate) async fn start(
    cache: &SharedExports,
    store: &WebsiteStore,
    management: &Router,
    headers: &HeaderMap,
    owner: Uuid,
    input: StartInput,
) -> CallToolResult {
    match authorized(store, headers, input.website_id, input.delivery_id).await {
        Ok(true) => {}
        Ok(false) => {
            revoke(cache, owner, input.website_id, input.delivery_id).await;
            return failure("NOT_FOUND", "Audit is unavailable.");
        }
        Err(()) => return failure("UNAVAILABLE", "Audit access check failed."),
    }
    let mut cache = cache.clone().lock_owned().await;
    cache.reap();
    if let Some((id, entry)) = cache.entries.iter_mut().find(|(_, e)| {
        e.owner == owner && e.website == input.website_id && e.delivery == input.delivery_id
    }) {
        expire_idle(entry);
        return descriptor(*id, entry);
    }
    if cache.entries.len() >= MAX_EXPORTS {
        return failure(
            "EXPORT_CAPACITY",
            "Export capacity is temporarily unavailable.",
        );
    }
    let Some(auth) = headers.get(axum::http::header::AUTHORIZATION) else {
        return failure("UNAVAILABLE", "Authorization unavailable.");
    };
    let Ok(request) = Request::builder()
        .method(Method::GET)
        .uri(format!(
            "/websites/{}/seo/audits/{}",
            input.website_id, input.delivery_id
        ))
        .header(axum::http::header::AUTHORIZATION, auth)
        .body(Body::empty())
    else {
        return failure("UNAVAILABLE", "Export unavailable.");
    };
    let response = match management.clone().oneshot(request).await {
        Ok(r) => r,
        Err(e) => match e {},
    };
    if response.status() == StatusCode::NOT_FOUND || response.status() == StatusCode::FORBIDDEN {
        return failure("NOT_FOUND", "Audit is unavailable.");
    }
    if !response.status().is_success() {
        return failure("UNAVAILABLE", "Audit read failed.");
    }
    let Ok(file) = tempfile::tempfile() else {
        return failure(
            "EXPORT_CAPACITY",
            "Export storage is temporarily unavailable.",
        );
    };
    if !disk_backed(&file) {
        return failure(
            "EXPORT_CAPACITY",
            "Disk-backed export storage is unavailable.",
        );
    }
    let mut file = file;
    let mut stream = response.into_body().into_data_stream();
    let mut hash = Sha256::new();
    let mut bytes = 0_u64;
    let available = cache.capacity.saturating_sub(cache.used());
    while let Some(part) = stream.next().await {
        let Ok(part) = part else {
            return failure("UNAVAILABLE", "Audit read failed.");
        };
        let Some(next) = bytes.checked_add(part.len() as u64) else {
            return failure(
                "EXPORT_CAPACITY",
                "Export storage is temporarily unavailable.",
            );
        };
        if next > available {
            return failure(
                "EXPORT_CAPACITY",
                "Export storage is temporarily unavailable.",
            );
        }
        hash.update(&part);
        let written = tokio::task::spawn_blocking(move || {
            let result = file.write_all(&part);
            (file, cache, result)
        })
        .await;
        let Ok((returned_file, returned_cache, Ok(()))) = written else {
            return failure(
                "EXPORT_CAPACITY",
                "Export storage is temporarily unavailable.",
            );
        };
        file = returned_file;
        cache = returned_cache;
        bytes = next;
    }
    // Keep the owned budget lock with the blocking validator. If the request is
    // cancelled, the worker still owns both the file and the capacity until it exits.
    let validated = tokio::task::spawn_blocking(move || {
        let valid = (|| {
            file.seek(SeekFrom::Start(0)).ok()?;
            let mut de = serde_json::Deserializer::from_reader(std::io::BufReader::new(&file));
            <serde::de::IgnoredAny as serde::Deserialize>::deserialize(&mut de).ok()?;
            de.end().ok()?;
            drop(de);
            valid_unicode(&mut file).ok()?.then_some(())
        })()
        .is_some();
        (file, cache, valid)
    })
    .await;
    let Ok((file, mut cache, true)) = validated else {
        return failure("UNAVAILABLE", "Audit response was invalid.");
    };
    let now = Utc::now();
    let id = Uuid::new_v4();
    let entry = Snapshot {
        owner,
        website: input.website_id,
        delivery: input.delivery_id,
        file,
        bytes,
        hash: format!("{:x}", hash.finalize()),
        hard: now + Duration::hours(2),
        idle: now + Duration::minutes(15),
    };
    let result = descriptor(id, &entry);
    cache.entries.insert(id, entry);
    result
}

pub(crate) async fn chunk(
    cache: &SharedExports,
    store: &WebsiteStore,
    headers: &HeaderMap,
    owner: Uuid,
    input: ChunkInput,
) -> CallToolResult {
    match authorized(store, headers, input.website_id, input.delivery_id).await {
        Ok(true) => {}
        Ok(false) => {
            revoke(cache, owner, input.website_id, input.delivery_id).await;
            return failure("NOT_FOUND", "Audit is unavailable.");
        }
        Err(()) => return failure("UNAVAILABLE", "Audit access check failed."),
    }
    let mut cache = cache.clone().lock_owned().await;
    cache.reap();
    let Some(e) = cache.entries.get_mut(&input.export_id).filter(|e| {
        e.owner == owner && e.website == input.website_id && e.delivery == input.delivery_id
    }) else {
        return failure("EXPORT_EXPIRED", "Export expired; start again.");
    };
    if input.offset > e.bytes {
        return failure("INVALID_ARGUMENT", "Offset exceeds export length.");
    }
    let len = usize::try_from((e.bytes - input.offset).min(CHUNK as u64))
        .expect("bounded chunk fits usize");
    let Ok(mut file) = e.file.try_clone() else {
        return failure("UNAVAILABLE", "Export read failed.");
    };
    let offset = input.offset;
    let read = tokio::task::spawn_blocking(move || {
        let result = (|| {
            let mut buf = vec![0; len];
            file.seek(SeekFrom::Start(offset))?;
            file.read_exact(&mut buf)?;
            Ok::<_, std::io::Error>(buf)
        })();
        (cache, result)
    })
    .await;
    let Ok((mut cache, Ok(buf))) = read else {
        return failure("UNAVAILABLE", "Export read failed.");
    };
    let Some(e) = cache.entries.get_mut(&input.export_id) else {
        return failure("EXPORT_EXPIRED", "Export expired; start again.");
    };
    expire_idle(e);
    let next = offset + len as u64;
    CallToolResult::structured(
        serde_json::json!({"version":1,"exportId":input.export_id,"offset":offset,"dataBase64":STANDARD.encode(buf),"nextOffset":next,"eof":next==e.bytes,"byteLength":e.bytes,"sha256":e.hash,"idleExpiresAt":e.idle.to_rfc3339()}),
    )
}

pub(crate) async fn close(
    cache: &SharedExports,
    store: &WebsiteStore,
    headers: &HeaderMap,
    owner: Uuid,
    input: ExportInput,
) -> CallToolResult {
    match authorized(store, headers, input.website_id, input.delivery_id).await {
        Ok(true) => {}
        Ok(false) => {
            revoke(cache, owner, input.website_id, input.delivery_id).await;
            return failure("NOT_FOUND", "Audit is unavailable.");
        }
        Err(()) => return failure("UNAVAILABLE", "Audit access check failed."),
    }
    let mut cache = cache.lock().await;
    cache.reap();
    if cache.entries.get(&input.export_id).is_some_and(|e| {
        e.owner == owner && e.website == input.website_id && e.delivery == input.delivery_id
    }) {
        cache.entries.remove(&input.export_id);
    }
    CallToolResult::structured(serde_json::json!({"version":1,"closed":true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_validator_rejects_invalid_utf8_and_surrogate_escapes() {
        for (data, valid) in [
            (b"{\"x\":\"\\ud83d\\ude00\"}".as_slice(), true),
            (b"{\"x\":\"\\ud800\"}".as_slice(), false),
            (b"{\"x\":\"\\udc00\"}".as_slice(), false),
            (b"{\"x\":\"\\ud800\\u0041\"}".as_slice(), false),
            (b"{\"x\":\"\xff\"}".as_slice(), false),
        ] {
            let mut f = tempfile::tempfile().unwrap();
            f.write_all(data).unwrap();
            assert_eq!(valid_unicode(&mut f).unwrap(), valid);
        }
    }
    async fn access_store() -> (WebsiteStore, tokio::task::JoinHandle<()>) {
        let router = Router::new().route(
            "/rest/v1/rpc/seosmith_audit_export_access",
            axum::routing::post(|| async { axum::Json(true) }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (WebsiteStore::new(&url, "fixture"), task)
    }
    #[tokio::test]
    async fn malformed_or_truncated_json_never_produces_ready_snapshot() {
        if !tempfile::tempfile().is_ok_and(|file| disk_backed(&file)) {
            let _ = std::io::Write::write_all(&mut std::io::stderr(), b"SKIP malformed_or_truncated_json_never_produces_ready_snapshot: disk-backed TMPDIR required; rerun with TMPDIR=/var/tmp (or another verified disk directory)\n");
            return;
        }
        let (store, server) = access_store().await;
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer test".parse().unwrap());
        for body in [
            b"{\"report\":\"\\ud800\"}".as_slice(),
            b"{\"report\":[1,2".as_slice(),
            b"{\"report\":\"\xff\"}".as_slice(),
        ] {
            let body = body.to_vec();
            let management = Router::new().route(
                "/{*path}",
                axum::routing::get(move || {
                    let body = body.clone();
                    async move { Body::from(body) }
                }),
            );
            let cache: SharedExports = Arc::default();
            let result = start(
                &cache,
                &store,
                &management,
                &headers,
                Uuid::from_u128(9),
                StartInput {
                    website_id: Uuid::from_u128(1),
                    delivery_id: Uuid::from_u128(2),
                },
            )
            .await;
            assert_eq!(result.structured_content.unwrap()["code"], "UNAVAILABLE");
            assert!(cache.lock().await.entries.is_empty());
        }
        server.abort();
    }
    #[tokio::test]
    async fn capacity_failure_never_publishes_partial_snapshot() {
        if !tempfile::tempfile().is_ok_and(|file| disk_backed(&file)) {
            let _ = std::io::Write::write_all(&mut std::io::stderr(), b"SKIP capacity_failure_never_publishes_partial_snapshot: disk-backed TMPDIR required; rerun with TMPDIR=/var/tmp (or another verified disk directory)\n");
            return;
        }
        let (store, server) = access_store().await;
        let management = Router::new().route(
            "/{*path}",
            axum::routing::get(|| async { "{\"data\":\"more than four bytes\"}" }),
        );
        let cache: SharedExports = Arc::new(Mutex::new(Exports {
            entries: HashMap::new(),
            capacity: 4,
        }));
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer test".parse().unwrap());
        let result = start(
            &cache,
            &store,
            &management,
            &headers,
            Uuid::from_u128(9),
            StartInput {
                website_id: Uuid::from_u128(1),
                delivery_id: Uuid::from_u128(2),
            },
        )
        .await;
        assert_eq!(
            result.structured_content.unwrap()["code"],
            "EXPORT_CAPACITY"
        );
        assert!(cache.lock().await.entries.is_empty());
        server.abort();
    }
    #[tokio::test]
    async fn cancelled_preparation_releases_lock_and_never_publishes_snapshot() {
        if !tempfile::tempfile().is_ok_and(|file| disk_backed(&file)) {
            let _ = std::io::Write::write_all(&mut std::io::stderr(), b"SKIP cancelled_preparation_releases_lock_and_never_publishes_snapshot: disk-backed TMPDIR required; rerun with TMPDIR=/var/tmp (or another verified disk directory)\n");
            return;
        }
        let (store, server) = access_store().await;
        let notified = Arc::new(tokio::sync::Notify::new());
        let signal = notified.clone();
        let management = Router::new().route(
            "/{*path}",
            axum::routing::get(move || {
                let signal = signal.clone();
                async move {
                    let stream = futures_util::stream::once(async move {
                        signal.notify_one();
                        Ok::<_, std::io::Error>(axum::body::Bytes::from_static(b"{\"report\":"))
                    })
                    .chain(futures_util::stream::pending());
                    Body::from_stream(stream)
                }
            }),
        );
        let cache: SharedExports = Arc::default();
        let task_cache = cache.clone();
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer test".parse().unwrap());
        let task = tokio::spawn(async move {
            start(
                &task_cache,
                &store,
                &management,
                &headers,
                Uuid::from_u128(9),
                StartInput {
                    website_id: Uuid::from_u128(1),
                    delivery_id: Uuid::from_u128(2),
                },
            )
            .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), notified.notified())
            .await
            .unwrap();
        task.abort();
        let _ = task.await;
        let state = tokio::time::timeout(std::time::Duration::from_secs(5), cache.lock())
            .await
            .unwrap();
        assert!(state.entries.is_empty());
        drop(state);
        server.abort();
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn rejects_memory_backed_export_storage() {
        if let Ok(file) = tempfile::tempfile_in("/dev/shm") {
            assert!(!disk_backed(&file));
        }
    }
    #[test]
    fn expired_snapshots_are_reaped() {
        let mut cache = Exports::default();
        let now = Utc::now();
        let id = Uuid::new_v4();
        cache.entries.insert(
            id,
            Snapshot {
                owner: Uuid::nil(),
                website: Uuid::nil(),
                delivery: Uuid::nil(),
                file: tempfile::tempfile().unwrap(),
                bytes: 1,
                hash: String::new(),
                hard: now + Duration::hours(1),
                idle: now - Duration::seconds(1),
            },
        );
        cache.reap();
        assert!(cache.entries.is_empty());
    }
}
