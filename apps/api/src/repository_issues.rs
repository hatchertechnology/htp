//! Live public GitHub issues, scoped through the website owner's saved binding.
use super::{normalize_repository, read};
use crate::websites::{WebsiteError, WebsiteStore};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;
use uuid::Uuid;

#[derive(Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum IssueState {
    #[default]
    Open,
    Closed,
    All,
}
impl IssueState {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
            Self::All => "all",
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct IssueQuery {
    #[serde(default)]
    state: IssueState,
    #[serde(default = "first_page")]
    page: u32,
}
fn first_page() -> u32 {
    1
}

pub(super) async fn list(
    State(store): State<WebsiteStore>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Query(q): Query<IssueQuery>,
) -> Result<Json<Value>, WebsiteError> {
    if !(1..=10000).contains(&q.page) {
        return Err(WebsiteError::Invalid("Choose a valid issues page."));
    }
    // This RPC verifies the signed-in owner before any GitHub request.
    let history = read(&store, &headers, Some(id), None, None, None, None).await?;
    let Some(url) = history["repository"]["repository_url"].as_str() else {
        return Ok(Json(
            json!({"repository_url":null,"issues":[],"has_more":false}),
        ));
    };
    let url = normalize_repository(url)?;
    let path = url
        .strip_prefix("https://github.com/")
        .ok_or(WebsiteError::Unavailable)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| WebsiteError::Unavailable)?;
    let page = fetch(
        &client,
        &format!("https://api.github.com/repos/{path}/issues"),
        &url,
        &q,
    )
    .await?;
    Ok(Json(page))
}

async fn fetch(
    client: &reqwest::Client,
    endpoint: &str,
    repository: &str,
    q: &IssueQuery,
) -> Result<Value, WebsiteError> {
    // Never forward the dashboard bearer token to GitHub. Public repositories need no credentials.
    let response = client
        .get(endpoint)
        .header("User-Agent", "HatchTechPlatform")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .query(&[
            ("labels", "HTP"),
            ("state", q.state.as_str()),
            ("sort", "updated"),
            ("direction", "desc"),
            ("per_page", "100"),
            ("page", &q.page.to_string()),
        ])
        .send()
        .await
        .map_err(|_| WebsiteError::GitHub("GitHub could not be reached. Try again."))?;
    match response.status().as_u16() {
        200 => {}
        403 | 429 => {
            return Err(WebsiteError::GitHub(
                "GitHub’s request limit was reached or access was denied. Try again later.",
            ));
        }
        404 | 410 => {
            return Err(WebsiteError::GitHub(
                "This public repository or its issues are unavailable. Check the repository under Websites.",
            ));
        }
        _ => {
            return Err(WebsiteError::GitHub(
                "GitHub issues could not load. Try again later.",
            ));
        }
    }
    let has_more = response
        .headers()
        .get("link")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|link| link.contains("rel=\"next\"")));
    let rows: Vec<Value> = response.json().await.map_err(|_| {
        WebsiteError::GitHub("GitHub returned an unreadable issues response. Try again.")
    })?;
    Ok(
        json!({"repository_url":repository,"issues":project_issues(rows, repository),"has_more":has_more}),
    )
}

fn project_issues(rows: Vec<Value>, repository: &str) -> Vec<Value> {
    rows.into_iter()
        .filter(|row| row.get("pull_request").is_none())
        .filter(|row| {
            row["labels"].as_array().is_some_and(|labels| {
                labels.iter().any(|label| {
                    label["name"]
                        .as_str()
                        .is_some_and(|name| name.eq_ignore_ascii_case("HTP"))
                })
            })
        })
        .filter_map(|row| {
            let number = row["number"].as_u64()?;
            Some(
                json!({"number":number,"title":row["title"],"state":row["state"],
                "url":format!("{repository}/issues/{number}"),"updated_at":row["updated_at"]}),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_htp_issues_are_returned_with_safe_links() {
        let issue = json!({"number":42,"title":"Improve headings","state":"open","labels":[{"name":"htp"}],"html_url":"https://untrusted.test"});
        let mut pr = issue.clone();
        pr["pull_request"] = json!({});
        let mut other = issue.clone();
        other["labels"] = json!([{"name":"HTP-other"}]);
        let result = project_issues(vec![issue, pr, other], "https://github.com/example/site");
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0]["url"],
            "https://github.com/example/site/issues/42"
        );
    }
    #[tokio::test]
    async fn github_query_filters_labels_state_and_pages_without_credentials() {
        let app = axum::Router::new().route("/issues", axum::routing::get(|headers: HeaderMap, Query(q): Query<std::collections::HashMap<String,String>>| async move {
            assert!(!headers.contains_key("authorization"));
            assert_eq!(q["labels"], "HTP"); assert_eq!(q["state"], "closed");
            assert_eq!(q["page"], "2"); assert_eq!(q["sort"], "updated");
            ([("link", "<https://api.github.com/next>; rel=\"next\"")], Json(json!([])))
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/issues", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let result = fetch(
            &reqwest::Client::new(),
            &endpoint,
            "https://github.com/example/site",
            &IssueQuery {
                state: IssueState::Closed,
                page: 2,
            },
        )
        .await
        .ok()
        .unwrap();
        assert_eq!(result["has_more"], true);
        server.abort();
    }
}
