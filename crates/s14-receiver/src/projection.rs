//! Only materialize fields read by the local rule checks; retain the input bytes.
use crate::InspectionError;
use serde_json::{Map, Value, value::RawValue};
use std::collections::BTreeMap;

type RawMap<'a> = BTreeMap<String, &'a RawValue>;

fn object(raw: &RawValue, fields: &[(&str, Kind)]) -> Result<Value, InspectionError> {
    let Ok(entries): Result<RawMap<'_>, _> = serde_json::from_str(raw.get()) else {
        return serde_json::from_str(raw.get()).map_err(|_| InspectionError::Shape);
    };
    let mut result = Map::new();
    for (name, kind) in fields {
        if let Some(value) = entries.get(*name) {
            let value = match kind {
                Kind::Value => {
                    serde_json::from_str(value.get()).map_err(|_| InspectionError::Shape)?
                }
                Kind::Object(fields) => object(value, fields)?,
                Kind::Array(fields) => {
                    let Ok(items): Result<Vec<&RawValue>, _> = serde_json::from_str(value.get())
                    else {
                        result.insert(
                            (*name).to_owned(),
                            serde_json::from_str(value.get())
                                .map_err(|_| InspectionError::Shape)?,
                        );
                        continue;
                    };
                    Value::Array(
                        items
                            .into_iter()
                            .map(|v| object(v, fields))
                            .collect::<Result<_, _>>()?,
                    )
                }
            };
            result.insert((*name).to_owned(), value);
        }
    }
    Ok(Value::Object(result))
}
#[derive(Clone, Copy)]
enum Kind {
    Value,
    Object(&'static [(&'static str, Kind)]),
    Array(&'static [(&'static str, Kind)]),
}
use Kind::{Array, Object, Value as V};
const LINK: &[(&str, Kind)] = &[("url", V)];
const ALT: &[(&str, Kind)] = &[("language", V), ("url", V)];
const RELATIONSHIP: &[(&str, Kind)] = &[
    ("url", V),
    ("kind", V),
    ("resource", V),
    ("state", V),
    ("descriptor", V),
];
const PAGE: &[(&str, Kind)] = &[
    ("url", V),
    ("is_resource", V),
    ("status", V),
    ("error", V),
    ("blocked_by_robots", V),
    ("extraction_truncated", V),
    ("content_type", V),
    ("title", V),
    ("description", V),
    ("words", V),
    ("depth", V),
    ("bytes", V),
    ("ttfb_ms", V),
    ("dom_nodes", V),
    ("flags", V),
    ("links", Array(LINK)),
    ("robots", V),
    ("alternates", Array(ALT)),
    ("relationships", Array(RELATIONSHIP)),
    ("redirect", V),
    ("refresh_target", V),
    ("canonical", V),
];
const REQUEST: &[(&str, Kind)] = &[("url", V), ("check_external_links", V)];
const CONFIG: &[(&str, Kind)] = &[
    ("title_min", V),
    ("title_max", V),
    ("description_min", V),
    ("description_max", V),
    ("words_min", V),
    ("links_max", V),
    ("require_indexable", V),
    ("forbid_redirects", V),
];
const CANDIDATE: &[(&str, Kind)] = &[
    ("policy_digest", V),
    ("manifest_digest", V),
    ("scope_digest", V),
    ("coverage", V),
    ("records", V),
];
const GUIDANCE: &[(&str, Kind)] = &[
    ("catalog", V),
    ("manifest", V),
    ("config", Object(CONFIG)),
    ("candidate", Object(CANDIDATE)),
];
const ROOT: &[(&str, Kind)] = &[
    ("schema_version", V),
    ("engine_version", V),
    ("ruleset_version", V),
    ("started_at", V),
    ("finished_at", V),
    ("pages", Array(PAGE)),
    ("request", Object(REQUEST)),
    ("coverage_complete", V),
    ("outcome", V),
    ("stop_reason", V),
    ("policy_guidance", Object(GUIDANCE)),
];

pub(crate) fn project(input: &[u8]) -> Result<Value, InspectionError> {
    let raw: &RawValue = serde_json::from_slice(input).map_err(|_| InspectionError::Shape)?;
    object(raw, ROOT)
}
