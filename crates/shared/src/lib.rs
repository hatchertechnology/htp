//! Shared API response types for the HTP server and CLI.

pub mod analytics;

use serde::{Deserialize, Serialize};

/// A message returned by the API and consumed by clients.
#[derive(Debug, Deserialize, Serialize)]
pub struct MessageResponse {
    pub message: String,
}

/// A website record, independent of its content or future client relationships.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Website {
    pub id: uuid::Uuid,
    pub fqdn: String,
    #[serde(default)]
    pub ga4_property_id: Option<String>,
}

/// The only editable website field.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WebsiteInput {
    pub fqdn: String,
}

/// A bounded page of website records.
#[derive(Debug, Deserialize, Serialize)]
pub struct WebsitePage {
    pub items: Vec<Website>,
    pub has_more: bool,
}

/// Canonicalize a DNS hostname, preserving subdomains and accepting IDNs.
///
/// # Errors
/// Rejects URLs, IP addresses, local names, invalid labels, and overlong names.
pub fn normalize_fqdn(input: &str) -> Result<String, &'static str> {
    const ERROR: &str =
        "Enter a full domain name such as www.example.com, without a scheme, port, or path.";
    let input = input.trim();
    if input.len() > 1024 {
        return Err(ERROR);
    }
    let name = input.strip_suffix('.').unwrap_or(input);
    let name = idna::domain_to_ascii_strict(name)
        .map_err(|_| ERROR)?
        .to_ascii_lowercase();
    let labels: Vec<_> = name.split('.').collect();
    if name.len() > 253
        || labels.len() < 2
        || !labels
            .last()
            .is_some_and(|label| label.bytes().any(|byte| byte.is_ascii_alphabetic()))
        || labels.iter().any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return Err(ERROR);
    }
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::normalize_fqdn;

    #[test]
    fn canonicalizes_domains_without_losing_subdomains() {
        for (input, expected) in [
            (" WWW.DreamCleanMacon.COM. ", "www.dreamcleanmacon.com"),
            ("bücher.de", "xn--bcher-kva.de"),
            ("a.example.com", "a.example.com"),
        ] {
            assert_eq!(normalize_fqdn(input), Ok(expected.to_owned()));
        }
    }

    #[test]
    fn rejects_non_domain_inputs() {
        for input in [
            "",
            "localhost",
            "https://example.com",
            "example.com/path",
            "example.com:443",
            "user@example.com",
            "*.example.com",
            "127.0.0.1",
            "[::1]",
            "bad..example.com",
            "example.com..",
            "-bad.example.com",
            "bad-.example.com",
            "has space.com",
            "bad_name.com",
            "foo.123",
        ] {
            assert!(normalize_fqdn(input).is_err(), "accepted {input}");
        }
        assert!(normalize_fqdn(&format!("{}.com", "a".repeat(64))).is_err());
        assert!(normalize_fqdn(&format!("{}.com", vec!["a".repeat(63); 4].join("."))).is_err());
    }
}
