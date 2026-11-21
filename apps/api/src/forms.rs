//! Validation primitives for website forms. These do not expose an endpoint.
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldType {
    Text,
    Email,
    Telephone,
    Multiline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Field {
    pub key: String,
    pub label: String,
    pub kind: FieldType,
    pub required: bool,
    pub max_length: usize,
}

/// Validate configuration before it is persisted, so validation never depends
/// on malformed or ambiguous field definitions.
pub fn validate_fields(fields: &[Field]) -> Result<(), &'static str> {
    if fields.is_empty() || fields.len() > 32 {
        return Err("A form must have between 1 and 32 fields.");
    }
    let mut keys = BTreeSet::new();
    for field in fields {
        if field.key.is_empty()
            || field.key.len() > 64
            || !field
                .key
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
            || !field.key.as_bytes()[0].is_ascii_lowercase()
            || matches!(field.key.as_str(), "website" | "submission_id")
            || !keys.insert(&field.key)
        {
            return Err("Field keys must be unique lowercase identifiers.");
        }
        if field.label.trim().is_empty()
            || field.label.chars().count() > 100
            || !(1..=5000).contains(&field.max_length)
        {
            return Err("Invalid field label or length limit.");
        }
    }
    Ok(())
}

/// Returns field-specific errors; callers must reject the entire submission if
/// this map is nonempty. No submitted values are placed in error messages.
pub fn validate_submission(
    fields: &[Field],
    values: &BTreeMap<String, String>,
) -> BTreeMap<String, &'static str> {
    let mut errors = BTreeMap::new();
    let known: BTreeSet<_> = fields.iter().map(|field| field.key.as_str()).collect();
    if values.keys().any(|key| !known.contains(key.as_str())) {
        errors.insert("_form".into(), "Submission contains an unknown field.");
    }
    for field in fields {
        let value = values.get(&field.key).map_or("", |s| s.trim());
        let error = if value.is_empty() && field.required {
            Some("This field is required.")
        } else if value.chars().count() > field.max_length {
            Some("This field is too long.")
        } else if !value.is_empty() && matches!(field.kind, FieldType::Email) && !valid_email(value)
        {
            Some("Enter a valid email address.")
        } else if value
            .chars()
            .any(|c| c == '\0' || (c.is_control() && !matches!(c, '\n' | '\r' | '\t')))
        {
            Some("This field contains invalid characters.")
        } else {
            None
        };
        if let Some(error) = error {
            errors.insert(field.key.clone(), error);
        }
    }
    errors
}

fn valid_email(value: &str) -> bool {
    if value.len() > 254 || value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && local.len() <= 64
        && !local.starts_with('.')
        && !local.ends_with('.')
        && !local.contains("..")
        && local
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"!#$%&'*+-/=?^_`{|}~.".contains(&c))
        && !domain.contains('@')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && domain.split('.').count() >= 2
        && domain.split('.').all(|part| {
            !part.is_empty()
                && !part.starts_with('-')
                && !part.ends_with('-')
                && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

/// Quote a CSV cell and neutralize spreadsheet formula prefixes, including
/// formulas hidden behind whitespace or control characters.
pub fn csv_cell(value: &str) -> String {
    let unsafe_prefix = matches!(
        value
            .trim_start_matches(|c: char| c.is_whitespace() || c.is_control())
            .chars()
            .next(),
        Some('=' | '+' | '-' | '@')
    );
    let mut cell = String::from("\"");
    if unsafe_prefix {
        cell.push('\'');
    }
    for c in value.chars() {
        if c == '\"' {
            cell.push('\"');
        }
        cell.push(c);
    }
    cell.push('\"');
    cell
}

/// Compare a browser Origin to a configured HTTPS origin, including port.
/// Missing or malformed origins are rejected; Referer fallback is a caller decision.
pub fn origin_matches(origin: &str, allowed: &[String]) -> bool {
    fn parse(value: &str) -> Option<reqwest::Url> {
        let url = reqwest::Url::parse(value).ok()?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return None;
        }
        Some(url)
    }
    let Some(origin) = parse(origin) else {
        return false;
    };
    allowed
        .iter()
        .filter_map(|item| parse(item))
        .any(|candidate| candidate.origin() == origin.origin())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fields() -> Vec<Field> {
        vec![
            Field {
                key: "name".into(),
                label: "Name".into(),
                kind: FieldType::Text,
                required: true,
                max_length: 100,
            },
            Field {
                key: "email".into(),
                label: "Email".into(),
                kind: FieldType::Email,
                required: true,
                max_length: 254,
            },
            Field {
                key: "phone".into(),
                label: "Phone".into(),
                kind: FieldType::Telephone,
                required: false,
                max_length: 50,
            },
            Field {
                key: "message".into(),
                label: "Message".into(),
                kind: FieldType::Multiline,
                required: false,
                max_length: 5000,
            },
        ]
    }
    #[test]
    fn dream_clean_requires_name_and_valid_email() {
        let fields = fields();
        assert!(validate_fields(&fields).is_ok());
        let mut values = BTreeMap::from([
            ("name".into(), "Ada".into()),
            ("email".into(), "ada@example.com".into()),
        ]);
        assert!(validate_submission(&fields, &values).is_empty());
        values.insert("email".into(), "not-an-email".into());
        values.insert("name".into(), " ".into());
        let errors = validate_submission(&fields, &values);
        assert!(errors.contains_key("email") && errors.contains_key("name"));
    }
    #[test]
    fn rejects_malformed_email_addresses() {
        for value in [
            "a..b@example.com",
            "a b@example.com",
            "a@localhost",
            "a@-example.com",
            "<x>@example.com",
            "a@example.com\r\nBcc:x",
        ] {
            assert!(!valid_email(value), "{value}");
        }
        assert!(valid_email("a+b@example.com"));
    }
    #[test]
    fn rejects_unknown_fields_and_duplicate_keys() {
        let mut definitions = fields();
        definitions.push(definitions[0].clone());
        assert!(validate_fields(&definitions).is_err());
        assert!(
            validate_submission(
                &fields(),
                &BTreeMap::from([("unexpected".into(), "x".into())])
            )
            .contains_key("_form")
        );
    }
    #[test]
    fn csv_quotes_and_neutralizes_formulas() {
        assert_eq!(csv_cell("  =1+1"), "\"'  =1+1\"");
        assert_eq!(csv_cell("x,\"y\""), "\"x,\"\"y\"\"\"");
        assert_eq!(csv_cell("safe"), "\"safe\"");
    }
    #[test]
    fn origins_are_exact_https_origins() {
        let allowed = vec!["https://www.dreamcleanmacon.com".into()];
        assert!(origin_matches("https://www.dreamcleanmacon.com", &allowed));
        for origin in [
            "",
            "null",
            "http://www.dreamcleanmacon.com",
            "https://dreamcleanmacon.com",
            "https://www.dreamcleanmacon.com.evil.test",
            "https://www.dreamcleanmacon.com:444",
            "https://www.dreamcleanmacon.com/path",
        ] {
            assert!(!origin_matches(origin, &allowed), "{origin}");
        }
    }
}
