use crate::google_auth;
use chrono::{NaiveDate, Utc};
use clap::{Args, Subcommand};
use htp_shared::analytics::{AnalyticsReport, AnalyticsRequest};
use std::{path::PathBuf, time::Duration};
use uuid::Uuid;

type Failure = Box<dyn std::error::Error>;

#[derive(Args)]
pub struct AnalyticsArgs {
    /// Google refresh-token file (contains credentials; keep private)
    #[arg(long, global = true, default_value_os_t = google_auth::default_token_file())]
    token_file: PathBuf,
    #[command(subcommand)]
    command: AnalyticsCommand,
}

#[derive(Subcommand)]
enum AnalyticsCommand {
    /// Connect a Google account with read-only Analytics access
    Login {
        /// Downloaded OAuth client JSON; application type must be Desktop app
        #[arg(long)]
        client_secrets: PathBuf,
        /// Print the sign-in URL without opening a browser
        #[arg(long)]
        no_browser: bool,
    },
    /// Fetch daily users, sessions and page views for one saved website
    Report {
        /// UUID of your website record in HTP
        #[arg(long)]
        website: Uuid,
        /// Numeric GA4 property ID, not a G- measurement ID
        #[arg(long)]
        property: String,
        /// Inclusive start date (YYYY-MM-DD); default: UTC date 30 days ago
        #[arg(long, default_value_t = default_start())]
        start_date: NaiveDate,
        /// Inclusive end date (YYYY-MM-DD); default: yesterday's UTC date
        #[arg(long, default_value_t = default_end())]
        end_date: NaiveDate,
    },
    /// Remove locally saved Google credentials
    Logout,
}

fn default_start() -> NaiveDate {
    Utc::now().date_naive() - chrono::Duration::days(30)
}
fn default_end() -> NaiveDate {
    Utc::now().date_naive() - chrono::Duration::days(1)
}

pub fn run(args: AnalyticsArgs, api_url: &str) -> Result<(), Failure> {
    match args.command {
        AnalyticsCommand::Login {
            client_secrets,
            no_browser,
        } => google_auth::login(&client_secrets, &args.token_file, no_browser),
        AnalyticsCommand::Logout => google_auth::logout(&args.token_file),
        AnalyticsCommand::Report {
            website,
            property,
            start_date,
            end_date,
        } => {
            let input = AnalyticsRequest {
                property_id: property,
                start_date,
                end_date,
            };
            input.validate()?;
            let url = report_url(api_url, website)?;
            let supabase_token = std::env::var("HTP_ACCESS_TOKEN")
                .map_err(|_| "Set HTP_ACCESS_TOKEN to your Supabase user access token.")?;
            let google_token = google_auth::access_token(&args.token_file)?;
            let report = fetch_report(url, &supabase_token, &google_token, &input)?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
    }
}

fn fetch_report(
    url: reqwest::Url,
    supabase_token: &str,
    google_access_token: &str,
    input: &AnalyticsRequest,
) -> Result<AnalyticsReport, Failure> {
    let mut authorization =
        reqwest::header::HeaderValue::from_str(&format!("Bearer {supabase_token}"))?;
    authorization.set_sensitive(true);
    let mut google_token = reqwest::header::HeaderValue::from_str(google_access_token)?;
    google_token.set_sensitive(true);
    let response = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(35))
        .build()?
        .post(url)
        .header(reqwest::header::AUTHORIZATION, authorization)
        .header("x-google-access-token", google_token)
        .json(&input)
        .send()?;
    if !response.status().is_success() {
        let status = response.status();
        let error: serde_json::Value = response.json().unwrap_or_default();
        let code = error
            .get("code")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("request_failed");
        let hint = match code {
            "google_authorization_required" => "Run analytics login again.",
            "google_access_denied" => {
                "Check your Google property access, granted scope, and enabled Data API."
            }
            "google_quota_exceeded" => "Google quota exceeded; try again later.",
            "google_report_rejected" => "Check the numeric GA4 property ID and date range.",
            _ if status == reqwest::StatusCode::NOT_FOUND => {
                "Website not found in your HTP account."
            }
            _ if status == reqwest::StatusCode::UNAUTHORIZED => {
                "Check HTP_ACCESS_TOKEN; your Supabase session may have expired."
            }
            _ => "Check the API connection and try again.",
        };
        return Err(format!("Analytics request failed ({status}). {hint}").into());
    }
    let report: AnalyticsReport = response.json()?;
    Ok(report)
}

fn report_url(base: &str, website: Uuid) -> Result<reqwest::Url, Failure> {
    let mut url = reqwest::Url::parse(base)?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Use an HTTPS API origin (or HTTP loopback for local development), without a path, query, or credentials.".into());
    }
    url.set_path(&format!("/websites/{website}/analytics"));
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_sends_both_credentials_and_preserves_google_data() {
        use std::io::{BufRead, BufReader, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = report_url(
            &format!("http://{}", listener.local_addr().unwrap()),
            Uuid::from_u128(1),
        )
        .unwrap();
        let input = AnalyticsRequest {
            property_id: "123".into(),
            start_date: "2026-10-01".parse().unwrap(),
            end_date: "2026-10-27".parse().unwrap(),
        };
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(&stream);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert!(
                line.starts_with("POST /websites/00000000-0000-0000-0000-000000000001/analytics ")
            );
            let mut headers = String::new();
            let mut length = 0;
            loop {
                line.clear();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap();
                }
                headers.push_str(&line.to_lowercase());
            }
            assert!(headers.contains("authorization: bearer supabase-test"));
            assert!(headers.contains("x-google-access-token: google-test"));
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(body["property_id"], "123");
            assert_eq!(body["start_date"], "2026-10-01");
            let body = serde_json::json!({"website":{"id":"00000000-0000-0000-0000-000000000001","fqdn":"www.example.com"}, "property_id":"123", "start_date":"2026-10-01", "end_date":"2026-10-27", "report":{"rows":[],"metadata":{"subjectToThresholding":true}}}).to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        let report = fetch_report(url, "supabase-test", "google-test", &input).unwrap();
        assert_eq!(report.website.fqdn, "www.example.com");
        assert_eq!(report.report["metadata"]["subjectToThresholding"], true);
        server.join().unwrap();
    }
    #[test]
    fn credentials_only_go_to_a_valid_api_origin() {
        let id = Uuid::nil();
        assert!(report_url("https://htp-api-kerry-hatcher.fly.dev", id).is_ok());
        assert!(report_url("http://127.0.0.1:3000/", id).is_ok());
        for input in [
            "http://example.com",
            "https://example.com/path",
            "https://user:pass@example.com",
            "https://example.com/?token=x",
            "file:///tmp/file",
        ] {
            assert!(report_url(input, id).is_err());
        }
    }
}
