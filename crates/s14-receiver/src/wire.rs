//! The wire contract a report claims (`s14-wire-1` or `s14-wire-2`).
//!
//! The label is read from the raw bytes (`policy_guidance.version`), never from
//! the projection: `projection.rs` whitelists `GUIDANCE` without a `version` key,
//! so projected checks cannot see it. v1 code paths stay byte-for-byte unchanged.
use crate::InspectionError;
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Wire {
    V1,
    V2,
}

impl Wire {
    pub(crate) fn from_label(label: &str) -> Option<Self> {
        match label {
            "s14-wire-1" => Some(Self::V1),
            "s14-wire-2" => Some(Self::V2),
            _ => None,
        }
    }
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::V1 => "s14-wire-1",
            Self::V2 => "s14-wire-2",
        }
    }
    /// Manifest byte cap: lists under v1, digest rows under v2.
    pub(crate) fn manifest_cap(self) -> usize {
        match self {
            Self::V1 => 262_144,
            Self::V2 => 16_384,
        }
    }
    /// S01 `evidence_contract` observation/evaluation cap checked at inspection.
    /// v1 is not counted by the receiver (SQL is the authority).
    pub(crate) fn evidence_counts(self) -> Option<(usize, usize)> {
        match self {
            Self::V1 => None,
            Self::V2 => Some((1024, 1024)),
        }
    }
}

#[derive(Deserialize)]
struct Labeled {
    policy_guidance: Option<Version>,
}
#[derive(Deserialize)]
struct Version {
    version: Option<String>,
}

/// The claimed label from the raw `policy_guidance` object; `None` if absent,
/// malformed or unknown.
pub(crate) fn claimed_guidance(guidance: &str) -> Option<Wire> {
    let v: Version = serde_json::from_str(guidance).ok()?;
    Wire::from_label(&v.version?)
}

/// Reads only `policy_guidance.version` from the raw bytes (no `deny_unknown_fields`).
///
/// # Errors
/// `Shape` when the member is absent or the input is not JSON; `Bounds` for any
/// label other than `s14-wire-1` and `s14-wire-2`.
pub(crate) fn wire_of(input: &[u8]) -> Result<Wire, InspectionError> {
    let l: Labeled = serde_json::from_slice(input).map_err(|_| InspectionError::Shape)?;
    let label = l
        .policy_guidance
        .and_then(|g| g.version)
        .ok_or(InspectionError::Shape)?;
    Wire::from_label(&label).ok_or(InspectionError::Bounds)
}

/// A9 framing: sha256("seosmith-candidates-v1\ncount=<n>\n" + "id=<len>:<id>\n"… + "end\n").
pub(crate) fn candidates_digest(ids: &[String]) -> String {
    let mut h = Sha256::new();
    h.update(format!("seosmith-candidates-v1\ncount={}\n", ids.len()));
    for id in ids {
        h.update(format!("id={}:{id}\n", id.len()));
    }
    h.update("end\n");
    format!("sha256:{:x}", h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(v: &str) -> Vec<u8> {
        format!(r#"{{"policy_guidance":{{"version":"{v}","x":1}},"other":true}}"#).into_bytes()
    }
    #[test]
    fn wire_of_reads_the_label() {
        assert_eq!(wire_of(&doc("s14-wire-1")), Ok(Wire::V1));
        assert_eq!(wire_of(&doc("s14-wire-2")), Ok(Wire::V2));
        assert_eq!(wire_of(&doc("s14-wire-3")), Err(InspectionError::Bounds));
        assert_eq!(wire_of(b"{}"), Err(InspectionError::Shape));
        assert_eq!(wire_of(b"nope"), Err(InspectionError::Shape));
        assert_eq!(claimed_guidance(r#"{"version":"s14-wire-3"}"#), None);
        assert_eq!(
            claimed_guidance(r#"{"version":"s14-wire-2"}"#),
            Some(Wire::V2)
        );
    }
    #[test]
    fn digest_framing_is_pinned() {
        // Independent of the implementation: hash of the literal framing.
        let want = format!(
            "sha256:{:x}",
            Sha256::digest(b"seosmith-candidates-v1\ncount=2\nid=1:a\nid=2:bc\nend\n")
        );
        assert_eq!(candidates_digest(&["a".into(), "bc".into()]), want);
        let empty = format!(
            "sha256:{:x}",
            Sha256::digest(b"seosmith-candidates-v1\ncount=0\nend\n")
        );
        assert_eq!(candidates_digest(&[]), empty);
        // length-prefixing: ["ab","c"] and ["a","bc"] differ
        assert_ne!(
            candidates_digest(&["ab".into(), "c".into()]),
            candidates_digest(&["a".into(), "bc".into()])
        );
    }
}
