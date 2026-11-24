//! Phase-one worker-only routing skeleton. No adapter or enabling path exists yet.
//! In particular this module cannot inspect a body, persist a proof or commit4.
use axum::{
    Json, Router,
    extract::Request,
    http::{StatusCode, header},
    response::IntoResponse,
    routing::post,
};
use serde_json::json;
pub(crate) const PATH: &str = "/integrations/seosmith/policy-audits";
pub(crate) fn router() -> Router {
    Router::new().route(PATH, post(disabled))
}
async fn disabled(_request: Request) -> impl IntoResponse {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"error":"policy_receiver_unavailable"})),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use futures_util::stream;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn installed_route_is_closed_without_polling_or_decoding_body() {
        let polls = Arc::new(AtomicUsize::new(0));
        let observed = polls.clone();
        let body = Body::from_stream(stream::poll_fn(move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
            std::task::Poll::Ready(Some(Err::<axum::body::Bytes, _>(std::io::Error::other(
                "body must not be read",
            ))))
        }));
        let app = crate::app_with_services(
            crate::auth::SupabaseAuth::new("http://127.0.0.1:1"),
            crate::websites::WebsiteStore::new("http://127.0.0.1:1", "synthetic"),
        );
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(PATH)
                    .header("content-type", "application/json")
                    .header("content-length", "33554432")
                    .header("authorization", "Bearer synthetic-not-a-real-token")
                    .body(body)
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(polls.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn no_other_method_can_open_the_worker_path() {
        let response = router()
            .oneshot(Request::builder().uri(PATH).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }
}
