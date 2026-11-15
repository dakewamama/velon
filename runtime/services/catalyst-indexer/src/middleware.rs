use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    middleware::Next,
    response::Response,
};
use std::sync::Arc;
use subtle::ConstantTimeEq;

pub async fn verify_helius_signature(
    State(secret): State<Arc<str>>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let auth_header = req
        .headers()
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;

    if !bool::from(auth_header.as_bytes().ct_eq(secret.as_bytes())) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    Ok(next.run(req).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, middleware, routing::post};
    use tower::ServiceExt;

    fn app() -> Router {
        Router::new()
            .route("/", post(|| async { "accepted" }))
            .layer(middleware::from_fn_with_state(
                Arc::<str>::from("fixture-secret"),
                verify_helius_signature,
            ))
    }

    #[tokio::test]
    async fn rejects_missing_empty_and_wrong_authorization_through_middleware() {
        for authorization in [None, Some(""), Some("wrong-secret")] {
            let mut request = Request::builder().method("POST").uri("/");
            if let Some(value) = authorization {
                request = request.header("Authorization", value);
            }
            let response = app()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
    }

    #[tokio::test]
    async fn matching_secret_reaches_the_handler() {
        let response = app()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/")
                    .header("Authorization", "fixture-secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}
