//! Worker-only schema-4 report route (`POST /integrations/seosmith/policy-audits`).
//!
//! API-mediated admission: the API runs `htp_s14_receiver::admit` on the exact
//! bytes inside the validation deadline, then makes one `commit_seosmith_v4`
//! call with the service key. The API is the semantic validator, so `admit`
//! ALWAYS runs before the RPC, including for retries of committed deliveries.
//! The database enforces binding (digests, validator revision, evidence) and
//! `service_role`-only EXECUTE.
//!
//! Request budget (below the producer's 30 s client timeout): the whole request
//! (token check, body read, admit, commit) is capped at `REQUEST_BUDGET` = 28 s.
//! Each phase gets what is left, never more than its own cap: token check 3 s,
//! body read 8 s, admit at most the remainder minus the `COMMIT_RESERVE` of 8 s
//! (so the commit always keeps at least that), commit the remainder. Unused time
//! carries forward, so the usual request keeps the full 15 s receiver deadline.
//!
//! Intake: a route-local permit (one) is taken with `try_acquire` before the
//! body is read, so at most one envelope is buffered at a time on the 256 MB
//! VM; a busy route answers 503 `busy` at once. The worker token is checked
//! against its binding before the intake permit and before admit, so a bogus
//! token holds neither permit.
//!
//! Gate: `HTP_S14_ADMISSION=true`. When it is anything else the route answers
//! 503 without reading the body. This route is the only caller of the service
//! key for report ingestion; the legacy `/audits` route never sees it.
use crate::websites::{CommitV4, CommitV4Error, WebsiteStore};
use axum::{
    Json, Router,
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use futures_util::StreamExt;
use htp_s14_receiver::{AdmissionError, Admitted, InspectionError, MAX_REPORT_BYTES, admit};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
use uuid::Uuid;

pub(crate) const PATH: &str = "/integrations/seosmith/policy-audits";
/// Gate environment variable. Only the exact value `true` opens the route.
pub(crate) const GATE_ENV: &str = "HTP_S14_ADMISSION";
const SERVICE_KEY_ENV: &str = "SUPABASE_SERVICE_ROLE_KEY";
/// The whole envelope (delivery id, digest, JSON-escaped report).
const ENVELOPE_LIMIT: usize = 32 * 1024 * 1024;
/// Receiver deadline, inside the outer timeout.
const ADMIT_DEADLINE: Duration = Duration::from_secs(15);
const OUTER_TIMEOUT: Duration = Duration::from_secs(25);
/// Whole request, below the producer's 30 s client timeout.
const REQUEST_BUDGET: Duration = Duration::from_secs(28);
/// A throughput floor: the measured worst-case envelope is 9,381,689 B (about
/// 2x the 4,952,756-byte report cap), needing roughly 1.24 MB/s to land
/// inside it, else every retry is 503 `body_timeout`. X measures the producer's
/// upload speed before the gate opens (haiku recheck, N-MINOR-2).
const BODY_DEADLINE: Duration = Duration::from_secs(8);
const TOKEN_CHECK_TIMEOUT: Duration = Duration::from_secs(3);
/// Concurrent pre-admit token lookups. Bogus bearers hold no other permit, so
/// this bounds the outbound work they can drive (haiku recheck, N-MAJOR-1).
const LOOKUP_SLOTS: usize = 4;
/// Admit never eats into this much time for the commit.
const COMMIT_RESERVE: Duration = Duration::from_secs(8);

type Validator = fn(&[u8], Instant) -> Result<Admitted, AdmissionError>;

struct State14 {
    store: WebsiteStore,
    /// `Some(key)` only when the gate is open and the service key is present.
    service_key: Option<String>,
    /// One envelope buffered at a time (held while the body is read and parsed).
    intake: Arc<Semaphore>,
    /// Caps concurrent token lookups; `try_acquire`, 503 `busy` when full.
    lookup: Arc<Semaphore>,
    request_budget: Duration,
    body_deadline: Duration,
    /// One validation at a time. The owned permit moves into the blocking
    /// closure, so a request timeout cannot free it while the work still runs.
    permit: Arc<Semaphore>,
    validate: Validator,
    admit_deadline: Duration,
    outer_timeout: Duration,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    delivery_id: Uuid,
    sha256: String,
    report_json: String,
}

/// The gate predicate: the route is open only for the exact value `true` and a
/// non-empty service key. Anything else (unset, `TRUE`, `1`, `true `, empty key)
/// is closed.
fn service_key_for(gate: Option<&str>, key: Option<&str>) -> Option<String> {
    if gate != Some("true") {
        return None;
    }
    let key = key.filter(|k| !k.is_empty());
    if key.is_none() {
        eprintln!("{GATE_ENV}=true but {SERVICE_KEY_ENV} is missing; policy route stays closed");
    }
    key.map(str::to_owned)
}

pub(crate) fn router(store: WebsiteStore) -> Router {
    let service_key = service_key_for(
        std::env::var(GATE_ENV).ok().as_deref(),
        std::env::var(SERVICE_KEY_ENV).ok().as_deref(),
    );
    router_with(State14 {
        store,
        service_key,
        intake: Arc::new(Semaphore::new(1)),
        lookup: Arc::new(Semaphore::new(LOOKUP_SLOTS)),
        request_budget: REQUEST_BUDGET,
        body_deadline: BODY_DEADLINE,
        permit: Arc::new(Semaphore::new(1)),
        validate: admit,
        admit_deadline: ADMIT_DEADLINE,
        outer_timeout: OUTER_TIMEOUT,
    })
}

fn router_with(state: State14) -> Router {
    Router::new()
        .route(PATH, post(handle))
        .with_state(Arc::new(state))
}

fn reply(status: StatusCode, body: Value) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], Json(body)).into_response()
}

fn error(status: StatusCode, name: &str) -> Response {
    reply(status, json!({"error": name}))
}

fn admission_response(failure: AdmissionError) -> Response {
    match failure.error {
        InspectionError::ByteLimit => error(StatusCode::PAYLOAD_TOO_LARGE, "report_limit"),
        // Load or a stub path, never a verdict on the report: retryable.
        InspectionError::Deadline | InspectionError::SemanticValidationNotImplemented => {
            error(StatusCode::SERVICE_UNAVAILABLE, "validation_unavailable")
        }
        other => reply(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({
                "error": "semantic_mismatch",
                "stage": failure.stage.as_str(),
                "reason": format!("{other:?}"),
            }),
        ),
    }
}

fn commit_response(failure: CommitV4Error) -> Response {
    match failure {
        CommitV4Error::ReportLimit => error(StatusCode::PAYLOAD_TOO_LARGE, "report_limit"),
        CommitV4Error::InvalidDelivery => error(StatusCode::BAD_REQUEST, "invalid_delivery"),
        CommitV4Error::InvalidWorker => error(StatusCode::FORBIDDEN, "invalid_worker"),
        CommitV4Error::DeliveryConflict => error(StatusCode::CONFLICT, "delivery_conflict"),
        CommitV4Error::ValidatorDisabled => {
            error(StatusCode::SERVICE_UNAVAILABLE, "validator_disabled")
        }
        CommitV4Error::EvidenceInvalid(detail) => reply(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({"error": "evidence_invalid", "detail": detail}),
        ),
        CommitV4Error::Binding => reply(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({"error": "semantic_mismatch", "stage": "binding"}),
        ),
        CommitV4Error::Unavailable => error(StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
    }
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|s| s.len() >= 32 && s.len() <= 512)
}

fn hex_sha256(bytes: &[u8]) -> String {
    use std::fmt::Write;
    Sha256::digest(bytes)
        .iter()
        .fold(String::with_capacity(64), |mut out, b| {
            let _ = write!(out, "{b:02x}");
            out
        })
}

/// The envelope, read with a hard 32 MiB cap whether or not a length is declared.
async fn read_limited(
    headers: &HeaderMap,
    body: Body,
) -> Result<Vec<u8>, (StatusCode, &'static str)> {
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok());
    if declared.is_some_and(|n| n > ENVELOPE_LIMIT) {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "report_limit"));
    }
    let mut bytes = Vec::with_capacity(declared.unwrap_or(0).min(ENVELOPE_LIMIT));
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            return Err((StatusCode::BAD_REQUEST, "invalid_delivery"));
        };
        if bytes.len() + chunk.len() > ENVELOPE_LIMIT {
            return Err((StatusCode::PAYLOAD_TOO_LARGE, "report_limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn busy(status: StatusCode) -> Response {
    let mut response = error(status, "busy");
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, header::HeaderValue::from_static("5"));
    response
}

/// Intake: the route-local permit, the bounded body read, and every envelope
/// check that needs no database. Returns the response to send on failure.
async fn read_envelope(
    state: &State14,
    headers: &HeaderMap,
    body: Body,
    started: Instant,
) -> Result<Envelope, Box<Response>> {
    // At most one envelope in memory: taken before the body is read.
    let Ok(intake) = state.intake.clone().try_acquire_owned() else {
        return Err(Box::new(busy(StatusCode::SERVICE_UNAVAILABLE)));
    };
    let read = tokio::time::timeout(
        state
            .body_deadline
            .min(state.request_budget.saturating_sub(started.elapsed())),
        read_limited(headers, body),
    )
    .await;
    let bytes = match read {
        Ok(Ok(bytes)) => bytes,
        Ok(Err((status, name))) => return Err(Box::new(error(status, name))),
        Err(_) => {
            return Err(Box::new(error(
                StatusCode::SERVICE_UNAVAILABLE,
                "body_timeout",
            )));
        }
    };
    // Parse off the executor. The intake permit moves in, so it is held until
    // the buffer is gone even if this request is dropped meanwhile.
    let parsed = tokio::task::spawn_blocking(move || {
        let parsed = serde_json::from_slice::<Envelope>(&bytes);
        drop(bytes);
        drop(intake);
        parsed
    })
    .await;
    let envelope = match parsed {
        Ok(Ok(envelope)) => envelope,
        Ok(Err(_)) => return Err(Box::new(error(StatusCode::BAD_REQUEST, "invalid_delivery"))),
        Err(_) => {
            return Err(Box::new(error(
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
            )));
        }
    };
    if envelope.report_json.len() > MAX_REPORT_BYTES {
        return Err(Box::new(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "report_limit",
        )));
    }
    let key_matches = headers.get("idempotency-key").and_then(|h| h.to_str().ok())
        == Some(envelope.delivery_id.to_string().as_str());
    let sha_shape = envelope.sha256.len() == 64
        && envelope
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !key_matches || !sha_shape || hex_sha256(envelope.report_json.as_bytes()) != envelope.sha256
    {
        return Err(Box::new(error(StatusCode::BAD_REQUEST, "invalid_delivery")));
    }

    Ok(envelope)
}

async fn handle(State(state): State<Arc<State14>>, request: Request) -> Response {
    let started = Instant::now();
    let left = |cap: Duration| cap.min(state.request_budget.saturating_sub(started.elapsed()));
    // Closed gate: answer before the body is touched.
    let Some(service_key) = state.service_key.as_deref() else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "policy_receiver_unavailable",
        );
    };
    let (parts, body) = request.into_parts();
    let Some(token) = bearer(&parts.headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    // Credential first: a bogus token never takes the intake or validation
    // slot and never buffers a body. Its one indexed lookup runs on the pooled
    // client under its own small cap. A disabled binding still passes on
    // purpose (H2 replays committed deliveries before checking `enabled`).
    let Ok(lookup) = state.lookup.clone().try_acquire_owned() else {
        return busy(StatusCode::SERVICE_UNAVAILABLE);
    };
    let found = state
        .store
        .seosmith_binding_exists(
            service_key,
            &hex_sha256(token.as_bytes()),
            left(TOKEN_CHECK_TIMEOUT),
        )
        .await;
    drop(lookup);
    match found {
        Ok(true) => {}
        Ok(false) => return commit_response(CommitV4Error::InvalidWorker),
        Err(failure) => return commit_response(failure),
    }
    let envelope = match read_envelope(&state, &parts.headers, body, started).await {
        Ok(envelope) => envelope,
        Err(response) => return *response,
    };
    let Ok(permit) = state.permit.clone().try_acquire_owned() else {
        return busy(StatusCode::TOO_MANY_REQUESTS);
    };
    let validate = state.validate;
    // Admit gets what is left minus the commit's reserve, and its receiver
    // deadline sits one second inside that.
    let outer = state
        .outer_timeout
        .min(left(Duration::MAX).saturating_sub(COMMIT_RESERVE));
    let deadline = Instant::now()
        + state
            .admit_deadline
            .min(outer.saturating_sub(Duration::from_secs(1)));
    let report = envelope.report_json;
    let work = tokio::task::spawn_blocking(move || {
        let _permit = permit; // held until the closure ends, whatever the caller does
        let result = validate(report.as_bytes(), deadline);
        (report, result)
    });
    let Ok(Ok((report, admitted))) = tokio::time::timeout(outer, work).await else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "validation_unavailable");
    };
    let admitted = match admitted {
        Ok(admitted) => admitted,
        Err(failure) => return admission_response(failure),
    };
    let Ok(summary_text) = std::str::from_utf8(&admitted.summary.canonical) else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "unavailable");
    };
    let commit = CommitV4 {
        p_token: token,
        p_delivery_id: envelope.delivery_id,
        p_sha256: &envelope.sha256,
        p_report_json: &report,
        p_summary_text: summary_text,
        p_validator_revision: admitted.validator_revision,
    };
    let commit_budget = left(Duration::MAX);
    if commit_budget.is_zero() {
        return error(StatusCode::SERVICE_UNAVAILABLE, "unavailable");
    }
    match state
        .store
        // commit_budget can be below the RPC's 20 s statement_timeout; accepted
        // (plan amendment, H3 recheck N-MAJOR-2): replay is idempotent.
        .commit_seosmith_v4(service_key, &commit, commit_budget)
        .await
    {
        Ok(receipt)
            if receipt.get("accepted") == Some(&Value::Bool(true))
                && receipt.get("sha256").and_then(Value::as_str) == Some(&envelope.sha256)
                && receipt.get("delivery_id").and_then(Value::as_str)
                    == Some(envelope.delivery_id.to_string().as_str()) =>
        {
            // Exactly the three fields, never the upstream object as is.
            reply(
                StatusCode::OK,
                json!({
                    "delivery_id": envelope.delivery_id,
                    "sha256": envelope.sha256,
                    "accepted": true,
                }),
            )
        }
        Ok(_) => error(StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
        Err(failure) => commit_response(failure),
    }
}

#[cfg(test)]
mod tests;
