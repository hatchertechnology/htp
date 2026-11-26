//! Worker-only schema-4 report route (`POST /integrations/seosmith/policy-audits`).
//!
//! API-mediated admission: the API runs `htp_s14_receiver::admit` on the exact
//! bytes inside the validation deadline, then makes one `commit_seosmith_v4`
//! call with the service key. The API is the semantic validator, so `admit`
//! ALWAYS runs before the RPC, including for retries of committed deliveries.
//! The database enforces binding (digests, validator revision, evidence) and
//! `service_role`-only EXECUTE.
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
use htp_s14_receiver::{
    AdmissionError, Admitted, InspectionError, MAX_REPORT_BYTES, VALIDATOR_REVISION, admit,
};
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

type Validator = fn(&[u8], Instant) -> Result<Admitted, AdmissionError>;

struct State14 {
    store: WebsiteStore,
    /// `Some(key)` only when the gate is open and the service key is present.
    service_key: Option<String>,
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

pub(crate) fn router(store: WebsiteStore) -> Router {
    let open = std::env::var(GATE_ENV).is_ok_and(|v| v == "true");
    let service_key = if open {
        let key = std::env::var(SERVICE_KEY_ENV)
            .ok()
            .filter(|k| !k.is_empty());
        if key.is_none() {
            eprintln!(
                "{GATE_ENV}=true but {SERVICE_KEY_ENV} is missing; policy route stays closed"
            );
        }
        key
    } else {
        None
    };
    router_with(State14 {
        store,
        service_key,
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

async fn handle(State(state): State<Arc<State14>>, request: Request) -> Response {
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
    let bytes = match read_limited(&parts.headers, body).await {
        Ok(bytes) => bytes,
        Err((status, name)) => return error(status, name),
    };
    let Ok(envelope) = serde_json::from_slice::<Envelope>(&bytes) else {
        return error(StatusCode::BAD_REQUEST, "invalid_delivery");
    };
    drop(bytes);
    if envelope.report_json.len() > MAX_REPORT_BYTES {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "report_limit");
    }
    let key_matches = parts
        .headers
        .get("idempotency-key")
        .and_then(|h| h.to_str().ok())
        == Some(envelope.delivery_id.to_string().as_str());
    let sha_shape = envelope.sha256.len() == 64
        && envelope
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !key_matches || !sha_shape || hex_sha256(envelope.report_json.as_bytes()) != envelope.sha256
    {
        return error(StatusCode::BAD_REQUEST, "invalid_delivery");
    }

    let Ok(permit) = state.permit.clone().try_acquire_owned() else {
        let mut response = error(StatusCode::TOO_MANY_REQUESTS, "busy");
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, header::HeaderValue::from_static("5"));
        return response;
    };
    let validate = state.validate;
    let deadline = Instant::now() + state.admit_deadline;
    let report = envelope.report_json;
    let work = tokio::task::spawn_blocking(move || {
        let _permit = permit; // held until the closure ends, whatever the caller does
        let result = validate(report.as_bytes(), deadline);
        (report, result)
    });
    let Ok(Ok((report, admitted))) = tokio::time::timeout(state.outer_timeout, work).await else {
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
    debug_assert_eq!(admitted.validator_revision, VALIDATOR_REVISION);
    match state.store.commit_seosmith_v4(service_key, &commit).await {
        Ok(receipt)
            if receipt.get("accepted") == Some(&Value::Bool(true))
                && receipt.get("sha256").and_then(Value::as_str) == Some(&envelope.sha256)
                && receipt.get("delivery_id").and_then(Value::as_str)
                    == Some(envelope.delivery_id.to_string().as_str()) =>
        {
            reply(StatusCode::OK, receipt)
        }
        Ok(_) => error(StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
        Err(failure) => commit_response(failure),
    }
}

#[cfg(test)]
mod tests;
