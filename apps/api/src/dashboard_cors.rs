//! Opt-in, exact-origin CORS for the static dashboard's website API routes.
//!
//! Covers explicitly listed website, repository, forms, and provider connection routes.
//! Requests from any origin other than the single configured origin receive no
//! CORS headers. Preflights are answered before authentication runs, so this
//! layer must sit outside the auth layer. Credentials are never allowed.

use axum::{
    extract::{Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};

/// Environment variable naming the single allowed origin, for example `https://dashboard.example`.
pub const ORIGIN_ENV: &str = "HTP_DASHBOARD_CORS_ORIGIN";

const ALLOWED_REQUEST_HEADERS: [&str; 2] = ["authorization", "content-type"];
const PREFLIGHT_MAX_AGE_SECONDS: &str = "600";

/// A validated, exact browser origin that is allowed to call the dashboard routes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DashboardCors {
    origin: HeaderValue,
}

/// Errors from parsing the configured origin.
#[derive(Debug, PartialEq, Eq)]
pub enum OriginError {
    Empty,
    NotAbsoluteHttpOrigin,
    NotLowercase,
    HasPathOrSuffix,
    HasForbiddenCharacter,
}

impl std::fmt::Display for OriginError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let reason = match self {
            Self::Empty => "origin is empty",
            Self::NotAbsoluteHttpOrigin => "origin must be an absolute http or https origin",
            Self::NotLowercase => "origin must be lowercase, as browsers serialize it",
            Self::HasPathOrSuffix => "origin must not include a path, query, fragment or slash",
            Self::HasForbiddenCharacter => "origin contains a wildcard, credentials or whitespace",
        };
        f.write_str(reason)
    }
}

impl DashboardCors {
    /// Parse one exact origin. Wildcards, paths, trailing slashes, userinfo and
    /// uppercase characters are rejected so the comparison is byte-exact.
    ///
    /// # Errors
    /// Returns an [`OriginError`] describing the first rule the value breaks.
    pub fn parse_origin(raw: &str) -> Result<Self, OriginError> {
        if raw.is_empty() {
            return Err(OriginError::Empty);
        }
        if raw
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '*' | ',' | '@'))
        {
            return Err(OriginError::HasForbiddenCharacter);
        }
        if raw != raw.to_ascii_lowercase() {
            return Err(OriginError::NotLowercase);
        }
        let rest = raw
            .strip_prefix("https://")
            .or_else(|| raw.strip_prefix("http://"))
            .ok_or(OriginError::NotAbsoluteHttpOrigin)?;
        if rest.is_empty() || rest.starts_with(':') {
            return Err(OriginError::NotAbsoluteHttpOrigin);
        }
        if rest.contains(['/', '?', '#']) {
            return Err(OriginError::HasPathOrSuffix);
        }
        let origin = HeaderValue::from_str(raw).map_err(|_| OriginError::HasForbiddenCharacter)?;
        Ok(Self { origin })
    }

    /// Read the optional origin setting. An unset or empty value disables the feature.
    /// A set but invalid value is an error so startup can fail closed.
    ///
    /// # Errors
    /// Returns an [`OriginError`] when the configured value is not one exact origin.
    pub fn from_setting(raw: Option<&str>) -> Result<Option<Self>, OriginError> {
        match raw {
            None | Some("") => Ok(None),
            Some(value) => Self::parse_origin(value).map(Some),
        }
    }

    /// The configured origin as a header value.
    pub fn origin(&self) -> &HeaderValue {
        &self.origin
    }
}

/// The methods exposed to the static dashboard for an exact route shape.
fn dashboard_methods(path: &str) -> Option<&'static str> {
    if matches!(
        path,
        "/providers/google/connection" | "/providers/bing/connection"
    ) {
        return Some("GET, DELETE");
    }
    if path == "/websites" {
        return Some("GET, POST, PATCH, DELETE");
    }
    if let Some(confirmation) = path.strip_prefix("/forms/host-verifications/") {
        let host = confirmation.strip_suffix("/confirm")?;
        return uuid::Uuid::parse_str(host).ok().map(|_| "POST");
    }
    let rest = path.strip_prefix("/websites/")?;
    if !rest.is_empty() && !rest.contains('/') {
        return Some("GET, POST, PATCH, DELETE");
    }
    let (site, resource) = rest.split_once('/')?;
    uuid::Uuid::parse_str(site).ok()?;
    match resource {
        "analytics/dashboard" | "bing/dashboard" | "insights/report" | "insights/history" => {
            return (site.len() == 36).then_some("POST");
        }
        "business/location" => return (site.len() == 36).then_some("PUT"),
        "repository" => return Some("GET, PUT"),
        "repository/history" | "repository/issues" => return Some("GET"),
        "forms" => return Some("GET, POST"),
        "forms/pilot-eligibility" | "forms/hosts" | "forms/origins" => return Some("GET"),
        "forms/host-verifications" => return Some("POST"),
        _ => {}
    }
    if let Some(inbox) = resource.strip_prefix("forms/") {
        let (form, responses) = inbox.split_once('/')?;
        uuid::Uuid::parse_str(form).ok()?;
        return match responses.strip_prefix("responses")? {
            "" => Some("GET"),
            response => uuid::Uuid::parse_str(response.strip_prefix('/')?)
                .ok()
                .map(|_| "GET"),
        };
    }
    match resource.strip_prefix("seo/audits")? {
        "" => Some("GET"),
        run => uuid::Uuid::parse_str(run.strip_prefix('/')?)
            .ok()
            .map(|_| "GET"),
    }
}

/// Axum middleware: answer covered preflights and add exact-origin headers to covered responses.
pub async fn layer(State(cors): State<DashboardCors>, request: Request, next: Next) -> Response {
    let Some(methods) = dashboard_methods(request.uri().path()) else {
        return next.run(request).await;
    };
    let method_is_allowed = |method: &str| methods.split(", ").any(|allowed| allowed == method);
    let origin_matches = request
        .headers()
        .get(header::ORIGIN)
        .is_some_and(|origin| origin == cors.origin());

    if request.method() == Method::OPTIONS {
        let requested_method = request
            .headers()
            .get(header::ACCESS_CONTROL_REQUEST_METHOD)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let requested_headers_ok = request
            .headers()
            .get(header::ACCESS_CONTROL_REQUEST_HEADERS)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|list| {
                list.split(',')
                    .map(|h| h.trim().to_ascii_lowercase())
                    .filter(|h| !h.is_empty())
                    .all(|h| ALLOWED_REQUEST_HEADERS.contains(&h.as_str()))
            });
        if origin_matches
            && requested_method.as_deref().is_some_and(method_is_allowed)
            && requested_headers_ok
        {
            let mut response = StatusCode::NO_CONTENT.into_response();
            add_origin_headers(response.headers_mut(), &cors);
            response.headers_mut().insert(
                header::ACCESS_CONTROL_ALLOW_METHODS,
                HeaderValue::from_static(methods),
            );
            response.headers_mut().insert(
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                HeaderValue::from_static("authorization, content-type"),
            );
            response.headers_mut().insert(
                header::ACCESS_CONTROL_MAX_AGE,
                HeaderValue::from_static(PREFLIGHT_MAX_AGE_SECONDS),
            );
            return response;
        }
        return next.run(request).await;
    }

    let method_ok = method_is_allowed(request.method().as_str());
    let mut response = next.run(request).await;
    if method_ok && origin_matches {
        add_origin_headers(response.headers_mut(), &cors);
    } else {
        response
            .headers_mut()
            .append(header::VARY, HeaderValue::from_static("Origin"));
    }
    response
}

/// Vary is always set on covered paths so caches key on Origin. Allow-Origin
/// is only written for the configured origin, and never with credentials.
fn add_origin_headers(headers: &mut axum::http::HeaderMap, cors: &DashboardCors) {
    headers.append(header::VARY, HeaderValue::from_static("Origin"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, cors.origin().clone());
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::Body,
        http::Request as HttpRequest,
        middleware::{self, from_fn},
        routing::get,
    };
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tower::ServiceExt;

    const ORIGIN: &str = "https://dashboard.example";

    fn cors() -> DashboardCors {
        DashboardCors::parse_origin(ORIGIN).unwrap()
    }

    /// Inner app: a route that counts calls, behind a fake auth gate that rejects
    /// requests without an Authorization header, like the real `require_user`.
    fn app(calls: Arc<AtomicUsize>, cors: DashboardCors) -> Router {
        let handler = move || {
            let calls = calls.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                "ok"
            }
        };
        let inner = Router::new()
            .route("/websites", get(handler.clone()).post(handler.clone()))
            .route(
                "/websites/{id}",
                get(handler.clone())
                    .patch(handler.clone())
                    .delete(handler.clone()),
            )
            .route("/websites/{id}/seo/audits", get(handler.clone()))
            .route(
                "/websites/{id}/repository",
                get(handler.clone()).put(handler.clone()),
            )
            .route("/websites/{id}/repository/history", get(handler.clone()))
            .route("/websites/{id}/repository/issues", get(handler.clone()))
            .route(
                "/websites/{id}/analytics/dashboard",
                axum::routing::post(handler.clone()),
            )
            .route(
                "/websites/{id}/bing/dashboard",
                axum::routing::post(handler.clone()),
            )
            .route(
                "/websites/{id}/insights/report",
                axum::routing::post(handler.clone()),
            )
            .route(
                "/websites/{id}/insights/history",
                axum::routing::post(handler.clone()),
            )
            .route(
                "/websites/{id}/business/location",
                axum::routing::put(handler.clone()),
            )
            .route("/forms/submit", axum::routing::post(handler.clone()))
            .route(
                "/websites/{id}/analytics/property",
                axum::routing::put(handler),
            )
            .layer(from_fn(require_authorization));
        inner.layer(middleware::from_fn_with_state(cors, layer))
    }

    async fn require_authorization(request: Request, next: Next) -> Response {
        if request.headers().contains_key(header::AUTHORIZATION) {
            next.run(request).await
        } else {
            StatusCode::UNAUTHORIZED.into_response()
        }
    }

    fn preflight(path: &str, origin: &str, method: &str) -> HttpRequest<Body> {
        HttpRequest::builder()
            .method(Method::OPTIONS)
            .uri(path)
            .header(header::ORIGIN, origin)
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, method)
            .header(
                header::ACCESS_CONTROL_REQUEST_HEADERS,
                "authorization, content-type",
            )
            .body(Body::empty())
            .unwrap()
    }

    fn actual(method: &str, path: &str, origin: Option<&str>, auth: bool) -> HttpRequest<Body> {
        let mut builder = HttpRequest::builder().method(method).uri(path);
        if let Some(origin) = origin {
            builder = builder.header(header::ORIGIN, origin);
        }
        if auth {
            builder = builder.header(header::AUTHORIZATION, "Bearer synthetic");
        }
        builder.body(Body::empty()).unwrap()
    }

    fn header_value(response: &Response, name: header::HeaderName) -> Option<&str> {
        response.headers().get(name).and_then(|v| v.to_str().ok())
    }

    // --- origin configuration ---

    #[test]
    fn accepts_one_exact_https_origin() {
        let parsed = DashboardCors::parse_origin("https://dashboard.example").unwrap();
        assert_eq!(parsed.origin(), "https://dashboard.example");
    }

    #[test]
    fn accepts_exact_origin_with_port() {
        assert!(DashboardCors::parse_origin("http://localhost:4173").is_ok());
    }

    #[test]
    fn rejects_malformed_or_non_exact_origins() {
        for raw in [
            "",
            "*",
            "https://*.example",
            "https://dashboard.example/",
            "https://dashboard.example/app",
            "https://dashboard.example?x=1",
            "https://dashboard.example#frag",
            "https://user@dashboard.example",
            "ftp://dashboard.example",
            "dashboard.example",
            "https://Dashboard.example",
            "https://dashboard.example ",
            "https://dashboard.example, https://other.example",
        ] {
            assert!(
                DashboardCors::parse_origin(raw).is_err(),
                "expected {raw:?} to be rejected"
            );
        }
    }

    #[test]
    fn unset_or_empty_setting_disables_the_feature() {
        assert_eq!(DashboardCors::from_setting(None), Ok(None));
        assert_eq!(DashboardCors::from_setting(Some("")), Ok(None));
    }

    #[test]
    fn set_but_invalid_setting_fails_closed() {
        assert!(DashboardCors::from_setting(Some("*")).is_err());
        assert!(DashboardCors::from_setting(Some("https://a.example/")).is_err());
    }

    #[test]
    fn covers_website_and_exact_saved_audit_routes() {
        let site = "00000000-0000-0000-0000-000000000001";
        let run = "00000000-0000-0000-0000-000000000002";
        assert!(dashboard_methods("/websites").is_some());
        assert!(dashboard_methods(&format!("/websites/{site}")).is_some());
        let audits = format!("/websites/{site}/seo/audits");
        assert_eq!(dashboard_methods(&audits), Some("GET"));
        assert_eq!(dashboard_methods(&format!("{audits}/{run}")), Some("GET"));
        for path in [
            "/websites/",
            "/websites/x/seo/audits",
            "/websites/x/analytics/property",
            "/forms/submit",
            "/websites-extra",
            &format!("{audits}/import"),
            &format!("{audits}/{run}/work"),
        ] {
            assert!(dashboard_methods(path).is_none(), "{path}");
        }
    }

    #[tokio::test]
    async fn saved_audit_preflight_allows_only_get() {
        let path = "/websites/00000000-0000-0000-0000-000000000001/seo/audits";
        for (method, allowed) in [("GET", Some("GET")), ("POST", None)] {
            let response = app(Arc::new(AtomicUsize::new(0)), cors())
                .oneshot(preflight(path, ORIGIN, method))
                .await
                .unwrap();
            assert_eq!(
                header_value(&response, header::ACCESS_CONTROL_ALLOW_METHODS),
                allowed
            );
        }
    }

    #[tokio::test]
    async fn forms_inbox_preflight_allows_only_exact_get_routes() {
        let site = "00000000-0000-0000-0000-000000000001";
        let form = "00000000-0000-0000-0000-000000000002";
        let response = "00000000-0000-0000-0000-000000000003";
        let forms = format!("/websites/{site}/forms");
        let responses = format!("{forms}/{form}/responses");
        for path in [&responses, &format!("{responses}/{response}")] {
            for (method, allowed) in [("GET", Some("GET")), ("POST", None)] {
                let result = app(Arc::new(AtomicUsize::new(0)), cors())
                    .oneshot(preflight(path, ORIGIN, method))
                    .await
                    .unwrap();
                assert_eq!(
                    header_value(&result, header::ACCESS_CONTROL_ALLOW_METHODS),
                    allowed,
                    "{method} {path}"
                );
            }
        }
        for path in [
            format!("{forms}/host-verifications/{response}"),
            format!("{forms}/invalid/responses"),
            format!("{responses}/{response}/extra"),
        ] {
            assert!(dashboard_methods(&path).is_none(), "{path}");
        }
    }

    #[tokio::test]
    async fn forms_setup_preflights_match_the_owner_api_methods() {
        let site = "00000000-0000-0000-0000-000000000001";
        let host = "00000000-0000-0000-0000-000000000002";
        let forms = format!("/websites/{site}/forms");
        let cases = [
            (forms.clone(), "GET", "GET, POST"),
            (forms.clone(), "POST", "GET, POST"),
            (format!("{forms}/pilot-eligibility"), "GET", "GET"),
            (format!("{forms}/hosts"), "GET", "GET"),
            (format!("{forms}/origins"), "GET", "GET"),
            (format!("{forms}/host-verifications"), "POST", "POST"),
            (
                format!("/forms/host-verifications/{host}/confirm"),
                "POST",
                "POST",
            ),
        ];
        for (path, method, methods) in cases {
            let response = app(Arc::new(AtomicUsize::new(0)), cors())
                .oneshot(preflight(&path, ORIGIN, method))
                .await
                .unwrap();
            assert_eq!(
                header_value(&response, header::ACCESS_CONTROL_ALLOW_METHODS),
                Some(methods)
            );
        }
        for (path, method) in [
            (format!("{forms}/hosts"), "POST"),
            (format!("{forms}/host-verifications"), "GET"),
            (
                format!("/forms/host-verifications/{host}/confirm/extra"),
                "POST",
            ),
            (format!("/public/forms/{site}"), "POST"),
        ] {
            let response = app(Arc::new(AtomicUsize::new(0)), cors())
                .oneshot(preflight(&path, ORIGIN, method))
                .await
                .unwrap();
            assert!(header_value(&response, header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
        }
    }

    #[tokio::test]
    async fn provider_cors_is_exact_and_only_allows_status_and_disconnect() {
        for path in ["/providers/google/connection", "/providers/bing/connection"] {
            assert_eq!(dashboard_methods(path), Some("GET, DELETE"));
            for method in ["GET", "DELETE", "POST"] {
                for origin in [ORIGIN, "https://evil.example"] {
                    let response = app(Arc::new(AtomicUsize::new(0)), cors())
                        .oneshot(preflight(path, origin, method))
                        .await
                        .unwrap();
                    let allowed = origin == ORIGIN && method != "POST";
                    assert_eq!(
                        header_value(&response, header::ACCESS_CONTROL_ALLOW_ORIGIN),
                        allowed.then_some(ORIGIN)
                    );
                    assert_eq!(
                        header_value(&response, header::ACCESS_CONTROL_ALLOW_METHODS),
                        allowed.then_some("GET, DELETE")
                    );
                    assert!(
                        header_value(&response, header::ACCESS_CONTROL_ALLOW_CREDENTIALS).is_none()
                    );
                }
                let response = app(Arc::new(AtomicUsize::new(0)), cors())
                    .oneshot(actual(method, path, Some(ORIGIN), false))
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
                assert_eq!(
                    header_value(&response, header::ACCESS_CONTROL_ALLOW_ORIGIN),
                    (method != "POST").then_some(ORIGIN)
                );
            }
        }
        for path in [
            "/providers/google/connection/",
            "/providers/bing/connect",
            "/providers/other/connection",
            "/providers/google/connection/extra",
        ] {
            assert_eq!(dashboard_methods(path), None);
        }
    }

    #[tokio::test]
    async fn repository_cors_matches_implemented_methods_and_preserves_auth() {
        let base = "/websites/00000000-0000-0000-0000-000000000001/repository";
        for (suffix, methods) in [("", "GET, PUT"), ("/history", "GET"), ("/issues", "GET")] {
            let path = format!("{base}{suffix}");
            assert_eq!(dashboard_methods(&path), Some(methods));
            for method in ["GET", "PUT", "POST", "PATCH", "DELETE"] {
                let allowed = methods.split(", ").any(|m| m == method);
                for origin in [ORIGIN, "https://evil.example"] {
                    let calls = Arc::new(AtomicUsize::new(0));
                    let response = app(calls.clone(), cors())
                        .oneshot(preflight(&path, origin, method))
                        .await
                        .unwrap();
                    assert_eq!(
                        header_value(&response, header::ACCESS_CONTROL_ALLOW_METHODS),
                        (allowed && origin == ORIGIN).then_some(methods)
                    );
                    assert_eq!(calls.load(Ordering::SeqCst), 0);
                    for auth in [false, true] {
                        let response = app(calls.clone(), cors())
                            .oneshot(actual(method, &path, Some(origin), auth))
                            .await
                            .unwrap();
                        assert_eq!(
                            header_value(&response, header::ACCESS_CONTROL_ALLOW_ORIGIN),
                            (allowed && origin == ORIGIN).then_some(ORIGIN)
                        );
                        assert!(
                            header_value(&response, header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
                                .is_none()
                        );
                        if !auth {
                            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
                        } else if allowed {
                            assert_eq!(response.status(), StatusCode::OK);
                        }
                    }
                }
            }
        }
        for path in [
            format!("{base}/"),
            format!("{base}/issues/extra"),
            format!("{base}/other"),
            "/websites/invalid/repository".into(),
        ] {
            assert_eq!(dashboard_methods(&path), None);
        }
    }

    #[tokio::test]
    async fn report_cors_is_exact_and_preserves_auth() {
        let site = "00000000-0000-0000-0000-000000000001";
        for (resource, expected) in [
            ("analytics/dashboard", "POST"),
            ("bing/dashboard", "POST"),
            ("insights/report", "POST"),
            ("insights/history", "POST"),
            ("business/location", "PUT"),
        ] {
            let path = format!("/websites/{site}/{resource}");
            assert_eq!(dashboard_methods(&path), Some(expected));
            for method in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
                for origin in [ORIGIN, "https://evil.example"] {
                    let allowed = method == expected && origin == ORIGIN;
                    let calls = Arc::new(AtomicUsize::new(0));
                    let response = app(calls.clone(), cors())
                        .oneshot(preflight(&path, origin, method))
                        .await
                        .unwrap();
                    assert_eq!(
                        header_value(&response, header::ACCESS_CONTROL_ALLOW_METHODS),
                        allowed.then_some(expected)
                    );
                    assert_eq!(calls.load(Ordering::SeqCst), 0);
                    let response = app(calls.clone(), cors())
                        .oneshot(actual(method, &path, Some(origin), true))
                        .await
                        .unwrap();
                    assert_eq!(
                        response.status(),
                        if method == expected {
                            StatusCode::OK
                        } else {
                            StatusCode::METHOD_NOT_ALLOWED
                        }
                    );
                    assert_eq!(
                        header_value(&response, header::ACCESS_CONTROL_ALLOW_ORIGIN),
                        allowed.then_some(ORIGIN)
                    );
                    let response = app(calls, cors())
                        .oneshot(actual(method, &path, Some(origin), false))
                        .await
                        .unwrap();
                    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
                    assert_eq!(
                        header_value(&response, header::ACCESS_CONTROL_ALLOW_ORIGIN),
                        allowed.then_some(ORIGIN)
                    );
                    assert!(
                        header_value(&response, header::ACCESS_CONTROL_ALLOW_CREDENTIALS).is_none()
                    );
                }
            }
            for invalid in [
                format!("{path}/"),
                format!("{path}/extra"),
                format!("/websites/invalid/{resource}"),
                format!("/websites/{}/{resource}", site.replace('-', "")),
            ] {
                assert_eq!(dashboard_methods(&invalid), None);
            }
        }
        for resource in [
            "analytics",
            "analytics/property",
            "insights",
            "business",
            "bing",
        ] {
            assert_eq!(
                dashboard_methods(&format!("/websites/{site}/{resource}")),
                None
            );
        }
    }

    // --- preflight ---

    #[tokio::test]
    async fn answers_matching_origin_preflight_before_auth() {
        let calls = Arc::new(AtomicUsize::new(0));
        let response = app(calls.clone(), cors())
            .oneshot(preflight("/websites/abc", ORIGIN, "PATCH"))
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            header_value(&response, header::ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(ORIGIN)
        );
        let methods = header_value(&response, header::ACCESS_CONTROL_ALLOW_METHODS).unwrap();
        for method in ["GET", "POST", "PATCH", "DELETE"] {
            assert!(methods.contains(method), "missing {method} in {methods}");
        }
        let headers = header_value(&response, header::ACCESS_CONTROL_ALLOW_HEADERS).unwrap();
        assert!(headers.contains("authorization"));
        assert!(headers.contains("content-type"));
        assert!(header_value(&response, header::ACCESS_CONTROL_ALLOW_CREDENTIALS).is_none());
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "preflight must not reach the handler"
        );
    }

    #[tokio::test]
    async fn answers_collection_post_preflight() {
        let calls = Arc::new(AtomicUsize::new(0));
        let response = app(calls.clone(), cors())
            .oneshot(preflight("/websites", ORIGIN, "POST"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn preflight_from_other_origin_gets_no_cors_headers() {
        let calls = Arc::new(AtomicUsize::new(0));
        let response = app(calls, cors())
            .oneshot(preflight("/websites", "https://evil.example", "GET"))
            .await
            .unwrap();
        assert_ne!(response.status(), StatusCode::NO_CONTENT);
        assert!(header_value(&response, header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
    }

    #[tokio::test]
    async fn origin_comparison_is_exact_not_prefix() {
        for origin in ["https://dashboard.example.evil", "http://dashboard.example"] {
            let response = app(Arc::new(AtomicUsize::new(0)), cors())
                .oneshot(preflight("/websites", origin, "GET"))
                .await
                .unwrap();
            assert!(
                header_value(&response, header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none(),
                "{origin} must not be allowed"
            );
        }
    }

    #[tokio::test]
    async fn preflight_for_disallowed_method_is_not_granted() {
        let response = app(Arc::new(AtomicUsize::new(0)), cors())
            .oneshot(preflight("/websites/abc", ORIGIN, "PUT"))
            .await
            .unwrap();
        assert!(header_value(&response, header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
        assert_ne!(response.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn preflight_on_uncovered_path_is_not_granted() {
        for path in [
            "/forms/submit",
            "/websites/abc/seo/audits",
            "/websites/abc/analytics/property",
        ] {
            let response = app(Arc::new(AtomicUsize::new(0)), cors())
                .oneshot(preflight(path, ORIGIN, "POST"))
                .await
                .unwrap();
            assert!(
                header_value(&response, header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none(),
                "{path} must not receive dashboard CORS"
            );
        }
    }

    // --- actual requests ---

    #[tokio::test]
    async fn authenticated_covered_response_carries_exact_origin() {
        let calls = Arc::new(AtomicUsize::new(0));
        let response = app(calls.clone(), cors())
            .oneshot(actual("GET", "/websites", Some(ORIGIN), true))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            header_value(&response, header::ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(ORIGIN)
        );
        assert!(header_value(&response, header::ACCESS_CONTROL_ALLOW_CREDENTIALS).is_none());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn unauthenticated_error_still_carries_origin_for_the_dashboard() {
        let response = app(Arc::new(AtomicUsize::new(0)), cors())
            .oneshot(actual("GET", "/websites", Some(ORIGIN), false))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            header_value(&response, header::ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(ORIGIN)
        );
    }

    #[tokio::test]
    async fn covered_response_for_other_origin_has_no_allow_origin() {
        let response = app(Arc::new(AtomicUsize::new(0)), cors())
            .oneshot(actual(
                "DELETE",
                "/websites/abc",
                Some("https://evil.example"),
                true,
            ))
            .await
            .unwrap();
        assert!(header_value(&response, header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
    }

    #[tokio::test]
    async fn uncovered_route_is_untouched_even_with_matching_origin() {
        let response = app(Arc::new(AtomicUsize::new(0)), cors())
            .oneshot(actual("POST", "/forms/submit", Some(ORIGIN), true))
            .await
            .unwrap();
        assert!(header_value(&response, header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
        assert!(header_value(&response, header::VARY).is_none());
    }

    #[tokio::test]
    async fn disabled_feature_adds_no_headers() {
        // With no configuration the layer is not mounted at all; the inner app
        // response must carry no dashboard CORS headers.
        let calls = Arc::new(AtomicUsize::new(0));
        let inner = Router::new()
            .route("/websites", get(|| async { "ok" }))
            .layer(from_fn(require_authorization));
        let response = inner
            .oneshot(actual("GET", "/websites", Some(ORIGIN), true))
            .await
            .unwrap();
        assert!(header_value(&response, header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}
