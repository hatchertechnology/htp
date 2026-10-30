//! Owner-scoped repository configuration and database-backed commit history.
use crate::websites::{WebsiteError, WebsiteStore};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::get,
};
use chrono::{NaiveDate, Utc};
use rmcp::schemars;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct RepositoryInput {
    /// Public GitHub repository URL; null pauses collection and retains history.
    pub repository_url: Option<String>,
    /// Branch name; null follows the repository's default branch.
    pub branch: Option<String>,
    #[serde(default = "enabled")]
    pub enabled: bool,
}
fn enabled() -> bool {
    true
}

pub(crate) fn normalize_repository(input: &str) -> Result<String, WebsiteError> {
    let trimmed = input.trim().trim_end_matches('/');
    let canonical = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    let path = canonical
        .strip_prefix("https://github.com/")
        .ok_or(WebsiteError::Invalid(
            "Use https://github.com/owner/repository.",
        ))?;
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 2
        || parts[0].is_empty()
        || parts[0].len() > 39
        || !parts[0].as_bytes()[0].is_ascii_alphanumeric()
        || !parts[0]
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        || parts[1].is_empty()
        || parts[1].len() > 100
        || matches!(parts[1], "." | "..")
        || !parts[1]
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
    {
        return Err(WebsiteError::Invalid(
            "Use https://github.com/owner/repository without a branch, query, or credentials.",
        ));
    }
    Ok(canonical.to_owned())
}
pub(crate) async fn save(
    store: &WebsiteStore,
    headers: &HeaderMap,
    id: Option<Uuid>,
    fqdn: Option<&str>,
    input: RepositoryInput,
) -> Result<Value, WebsiteError> {
    let url = input
        .repository_url
        .as_deref()
        .map(normalize_repository)
        .transpose()?;
    let branch = input
        .branch
        .map(|b| b.trim().to_owned())
        .filter(|b| !b.is_empty());
    if branch
        .as_ref()
        .is_some_and(|b| b.len() > 255 || b.chars().any(char::is_control))
    {
        return Err(WebsiteError::Invalid(
            "Enter a branch name of at most 255 characters.",
        ));
    }
    store.rpc(headers,"set_website_repository",json!({"p_website_id":id,"p_fqdn":fqdn,"p_repository_url":url,"p_branch":branch,"p_enabled":input.enabled})).await
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryQuery {
    start_date: Option<NaiveDate>,
    end_date: Option<NaiveDate>,
    before_id: Option<i64>,
}
pub(crate) async fn read(
    store: &WebsiteStore,
    headers: &HeaderMap,
    id: Option<Uuid>,
    fqdn: Option<&str>,
    start: Option<NaiveDate>,
    end: Option<NaiveDate>,
    before: Option<i64>,
) -> Result<Value, WebsiteError> {
    let end = end.unwrap_or_else(|| Utc::now().date_naive());
    let start = start.unwrap_or(end - chrono::Duration::days(28));
    if !(0..366).contains(&(end - start).num_days()) || before.is_some_and(|v| v <= 0) {
        return Err(WebsiteError::Invalid(
            "Choose a date range of at most 366 days and a valid history cursor.",
        ));
    }
    store.rpc(headers,"website_repository_history",json!({"p_website_id":id,"p_fqdn":fqdn,"p_start_date":start,"p_end_date":end,"p_before_id":before})).await
}
pub(crate) fn router(store: WebsiteStore) -> Router {
    Router::new()
        .route("/websites/{id}/repository", get(history).put(set))
        .route("/websites/{id}/repository/history", get(history))
        .with_state(store)
}
async fn set(
    State(store): State<WebsiteStore>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<RepositoryInput>,
) -> Result<Json<Value>, WebsiteError> {
    Ok(Json(save(&store, &headers, Some(id), None, input).await?))
}
async fn history(
    State(store): State<WebsiteStore>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Query(q): Query<HistoryQuery>,
) -> Result<Json<Value>, WebsiteError> {
    Ok(Json(
        read(
            &store,
            &headers,
            Some(id),
            None,
            q.start_date,
            q.end_date,
            q.before_id,
        )
        .await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_public_github_repository_urls_are_accepted() {
        assert_eq!(
            normalize_repository(" https://github.com/example/site.git/ ")
                .ok()
                .as_deref(),
            Some("https://github.com/example/site")
        );
        for invalid in [
            "http://github.com/a/b",
            "https://github.com.evil.test/a/b",
            "https://github.com/a/b/tree/main",
            "https://user:password@github.com/a/b",
            "https://github.com/a/..",
            "https://github.com/a/b?token=private",
            "file:///etc/passwd",
        ] {
            assert!(normalize_repository(invalid).is_err(), "{invalid}");
        }
    }
}
