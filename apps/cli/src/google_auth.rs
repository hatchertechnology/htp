//! Google desktop OAuth with PKCE, a loopback callback, and a private token file.

use oauth2::{
    AuthType, AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken, EndpointNotSet,
    EndpointSet, PkceCodeChallenge, RedirectUrl, RefreshToken, Scope, TokenResponse, TokenUrl,
    basic::BasicClient,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub const SCOPE: &str = "https://www.googleapis.com/auth/analytics.readonly";
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
type GoogleClient =
    BasicClient<EndpointSet, EndpointNotSet, EndpointNotSet, EndpointNotSet, EndpointSet>;
type Failure = Box<dyn std::error::Error>;

#[derive(Deserialize)]
struct ClientFile {
    installed: ClientDetails,
}
#[derive(Deserialize)]
struct ClientDetails {
    client_id: String,
    client_secret: String,
}

#[derive(Serialize, Deserialize)]
pub struct SavedGrant {
    client_id: String,
    client_secret: String,
    refresh_token: String,
}

pub fn default_token_file() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("htp/google-oauth.json")
}

fn client(id: &str, secret: &str, redirect: Option<&str>) -> Result<GoogleClient, Failure> {
    let mut client = BasicClient::new(ClientId::new(id.to_owned()))
        .set_client_secret(ClientSecret::new(secret.to_owned()))
        .set_auth_type(AuthType::RequestBody)
        .set_auth_uri(AuthUrl::new(AUTH_URL.into())?)
        .set_token_uri(TokenUrl::new(TOKEN_URL.into())?);
    if let Some(redirect) = redirect {
        client = client.set_redirect_uri(RedirectUrl::new(redirect.into())?);
    }
    Ok(client)
}

// Reuse the workspace's reqwest version with oauth2's transport-neutral interface.
fn oauth_http(request: oauth2::HttpRequest) -> Result<oauth2::HttpResponse, io::Error> {
    let (parts, body) = request.into_parts();
    let response = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(io::Error::other)?
        .request(parts.method, parts.uri.to_string())
        .headers(parts.headers)
        .body(body)
        .send()
        .map_err(io::Error::other)?;
    let mut output = oauth2::http::Response::builder().status(response.status());
    *output
        .headers_mut()
        .ok_or_else(|| io::Error::other("Invalid OAuth response"))? = response.headers().clone();
    output
        .body(response.bytes().map_err(io::Error::other)?.to_vec())
        .map_err(io::Error::other)
}

pub fn login(secrets: &Path, token_file: &Path, no_browser: bool) -> Result<(), Failure> {
    let config: ClientFile = serde_json::from_reader(fs::File::open(secrets)?.take(65_536))
        .map_err(|_| "Expected a Google Desktop app OAuth client JSON file (installed.client_id and installed.client_secret).")?;
    if !config
        .installed
        .client_id
        .ends_with(".apps.googleusercontent.com")
        || config.installed.client_secret.is_empty()
    {
        return Err("The Google Desktop app client configuration is invalid.".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let redirect = format!("http://{}/callback", listener.local_addr()?);
    let client = client(
        &config.installed.client_id,
        &config.installed.client_secret,
        Some(&redirect),
    )?;
    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let (url, state) = client
        .authorize_url(CsrfToken::new_random)
        .add_scope(Scope::new(SCOPE.into()))
        .set_pkce_challenge(challenge)
        .add_extra_param("access_type", "offline")
        .add_extra_param("prompt", "consent")
        .url();
    eprintln!(
        "Sign in to Google and grant Analytics read access:\n{url}\nWaiting up to 10 minutes for the local browser callback…"
    );
    if !no_browser {
        open_browser(url.as_str());
    }
    let code = wait_for_code(&listener, &state, Duration::from_secs(600))?;
    let token = client.exchange_code(AuthorizationCode::new(code)).set_pkce_verifier(verifier)
        .request(&oauth_http).map_err(|_| "Google could not complete authorization. Check your Desktop app client configuration and try again.")?;
    if token
        .scopes()
        .is_some_and(|scopes| !scopes.iter().any(|s| s.as_str() == SCOPE))
    {
        return Err(
            "Google Analytics read access was not granted. Run analytics login again.".into(),
        );
    }
    let refresh = token.refresh_token().ok_or(
        "Google did not issue a refresh token. Run analytics login again and grant offline access.",
    )?;
    let saved = SavedGrant {
        client_id: config.installed.client_id,
        client_secret: config.installed.client_secret,
        refresh_token: refresh.secret().clone(),
    };
    save(token_file, &saved)?;
    eprintln!(
        "Google Analytics connected. Local credentials saved to {}.",
        token_file.display()
    );
    Ok(())
}

fn open_browser(url: &str) {
    #[cfg(target_os = "linux")]
    let program = "xdg-open";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let _ = std::process::Command::new(program)
        .arg(url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let _ = url; // The URL is always printed for manual opening.
}

fn callback(target: &str, expected: &CsrfToken) -> Result<Option<String>, &'static str> {
    let url = reqwest::Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| "Invalid callback")?;
    if url.path() != "/callback" {
        return Ok(None);
    }
    let pairs: Vec<_> = url.query_pairs().collect();
    let values = |name: &str| {
        pairs
            .iter()
            .filter(|(key, _)| key == name)
            .map(|(_, v)| v.to_string())
            .collect::<Vec<_>>()
    };
    let states = values("state");
    if states.len() != 1 || CsrfToken::new(states[0].clone()) != *expected {
        return Ok(None);
    }
    if !values("error").is_empty() {
        return Err("Google authorization was denied. Run analytics login again when ready.");
    }
    let codes = values("code");
    if codes.len() != 1 || codes[0].is_empty() {
        return Err("Google returned no authorization code.");
    }
    Ok(Some(codes[0].clone()))
}

fn wait_for_code(
    listener: &TcpListener,
    state: &CsrfToken,
    timeout: Duration,
) -> Result<String, Failure> {
    listener.set_nonblocking(true)?;
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(30));
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        stream.set_write_timeout(Some(Duration::from_secs(2)))?;
        let mut line = String::new();
        if BufReader::new((&stream).take(8192))
            .read_line(&mut line)
            .is_err()
        {
            continue;
        }
        let mut parts = line.split_whitespace();
        let result = if parts.next() == Some("GET") {
            callback(parts.next().unwrap_or(""), state)
        } else {
            Ok(None)
        };
        let (status, body) = if matches!(&result, Ok(Some(_))) {
            (
                "200 OK",
                "Authorization received. You can close this window and return to the CLI to check the connection.",
            )
        } else {
            (
                "400 Bad Request",
                "Authorization was not accepted. Return to the CLI.",
            )
        };
        let _ = write!(
            stream,
            "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        if let Some(code) = result? {
            return Ok(code);
        }
    }
    Err("Google sign-in timed out. Run analytics login again.".into())
}

pub fn access_token(path: &Path) -> Result<String, Failure> {
    let saved = load(path)?;
    let token = client(&saved.client_id, &saved.client_secret, None)?
        .exchange_refresh_token(&RefreshToken::new(saved.refresh_token.clone()))
        .request(&oauth_http)
        .map_err(|_| "Google authorization could not be refreshed. Run analytics login again.")?;
    if let Some(refresh) = token.refresh_token() {
        save(
            path,
            &SavedGrant {
                refresh_token: refresh.secret().clone(),
                ..saved
            },
        )?;
    }
    Ok(token.access_token().secret().clone())
}

fn load(path: &Path) -> Result<SavedGrant, Failure> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "No Google connection found. Run analytics login first.")?;
    if !metadata.is_file() || metadata.len() > 65_536 {
        return Err("Invalid Google token file.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("Google token file must be private: chmod 600 <token-file>.".into());
        }
    }
    serde_json::from_reader(fs::File::open(path)?)
        .map_err(|_| "Invalid Google token file. Run analytics login again.".into())
}

fn save(path: &Path, saved: &SavedGrant) -> Result<(), Failure> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut dirs = fs::DirBuilder::new();
    dirs.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        dirs.mode(0o700);
    }
    dirs.create(parent)?;
    let temporary = parent.join(format!(".htp-oauth-{}", CsrfToken::new_random().secret()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> Result<(), Failure> {
        let mut file = options.open(&temporary)?;
        serde_json::to_writer(&mut file, saved)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub fn logout(path: &Path) -> Result<(), Failure> {
    match fs::remove_file(path) {
        Ok(()) => (),
        Err(e) if e.kind() == io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.into()),
    }
    eprintln!(
        "Local Google credentials removed. You can also revoke this app in your Google account's connected apps."
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exchanges_pkce_codes_and_refresh_tokens_using_google_protocol() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/token", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for grant in ["authorization_code", "refresh_token"] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut reader = BufReader::new(&stream);
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                assert!(line.starts_with("POST /token "));
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
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let url = reqwest::Url::parse(&format!(
                    "http://localhost/?{}",
                    String::from_utf8(body).unwrap()
                ))
                .unwrap();
                let params: std::collections::HashMap<_, _> = url.query_pairs().collect();
                assert_eq!(params["grant_type"], grant);
                assert_eq!(params["client_id"], "client.apps.googleusercontent.com");
                assert_eq!(params["client_secret"], "client-secret");
                if grant == "authorization_code" {
                    assert_eq!(params["code"], "test-code");
                    assert_eq!(params["code_verifier"], "test-verifier");
                    assert_eq!(params["redirect_uri"], "http://127.0.0.1:1234/callback");
                } else {
                    assert_eq!(params["refresh_token"], "test-refresh");
                }
                let response = r#"{"access_token":"test-access","token_type":"Bearer","expires_in":3600,"refresh_token":"test-refresh","scope":"https://www.googleapis.com/auth/analytics.readonly"}"#;
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
            }
        });
        let client = client(
            "client.apps.googleusercontent.com",
            "client-secret",
            Some("http://127.0.0.1:1234/callback"),
        )
        .unwrap()
        .set_token_uri(TokenUrl::new(endpoint).unwrap());
        let token = client
            .exchange_code(AuthorizationCode::new("test-code".into()))
            .set_pkce_verifier(oauth2::PkceCodeVerifier::new("test-verifier".into()))
            .request(&oauth_http)
            .unwrap();
        assert_eq!(token.access_token().secret(), "test-access");
        let token = client
            .exchange_refresh_token(token.refresh_token().unwrap())
            .request(&oauth_http)
            .unwrap();
        assert_eq!(token.access_token().secret(), "test-access");
        server.join().unwrap();
    }
    #[test]
    fn callback_requires_exact_state_and_a_single_code() {
        let state = CsrfToken::new("expected".into());
        assert_eq!(
            callback("/callback?state=expected&code=abc", &state),
            Ok(Some("abc".into()))
        );
        for input in [
            "/callback?state=wrong&code=abc",
            "/callback?code=abc",
            "/favicon.ico",
            "/callback?state=expected&state=wrong&code=abc",
        ] {
            assert_eq!(callback(input, &state), Ok(None));
        }
        assert!(callback("/callback?state=expected&code=a&code=b", &state).is_err());
        assert!(callback("/callback?state=expected&error=access_denied", &state).is_err());
    }
    #[test]
    fn refresh_credentials_round_trip_in_a_private_file() {
        let folder = std::env::temp_dir().join(format!(
            "htp-oauth-test-{}",
            CsrfToken::new_random().secret()
        ));
        let path = folder.join("credentials.json");
        let saved = SavedGrant {
            client_id: "test".into(),
            client_secret: "test".into(),
            refresh_token: "test-refresh".into(),
        };
        save(&path, &saved).unwrap();
        assert_eq!(load(&path).unwrap().refresh_token, "test-refresh");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        logout(&path).unwrap();
        assert!(!path.exists());
        fs::remove_dir(folder).unwrap();
    }
}
