//! Reverse proxy for registered apps: `ANY /apps/{name}/*path`.
//!
//! The registry is static configuration (`CENTAUR_APPS_JSON`), parsed once at
//! router construction. The proxy strips inbound credentials and asserts the
//! caller's identity to the app via `x-centaur-app`, so apps never see (or
//! need to validate) end-user auth material.

use std::{sync::Arc, sync::LazyLock, time::Duration};

use axum::{
    Extension, Router,
    body::Body,
    extract::{Path, RawQuery},
    http::{HeaderMap, HeaderName, HeaderValue, Method, header},
    response::Response,
    routing::any,
};
use serde::Deserialize;

use crate::{
    ApiError,
    routes::{AppState, non_empty_env},
};

const APPS_JSON_ENV: &str = "CENTAUR_APPS_JSON";
const APP_PROXY_API_KEY_ENV: &str = "CENTAUR_APP_PROXY_API_KEY";
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HTTP_READ_TIMEOUT: Duration = Duration::from_secs(60);

const APP_IDENTITY_HEADER: HeaderName = HeaderName::from_static("x-centaur-app");
const X_API_KEY: HeaderName = HeaderName::from_static("x-api-key");
const KEEP_ALIVE: HeaderName = HeaderName::from_static("keep-alive");

static HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .read_timeout(HTTP_READ_TIMEOUT)
        .build()
        .expect("reqwest client configuration is valid")
});

pub(crate) fn apps_proxy_router() -> Router<AppState> {
    apps_proxy_router_with_registry(registry_from_env())
}

fn apps_proxy_router_with_registry(registry: AppsRegistry) -> Router<AppState> {
    Router::new()
        .route("/apps/{name}", any(proxy_app_root))
        .route("/apps/{name}/", any(proxy_app_root))
        .route("/apps/{name}/{*path}", any(proxy_app_path))
        .layer(Extension(registry))
}

#[derive(Debug, Clone, Deserialize)]
struct AppEntry {
    name: String,
    url: String,
}

#[derive(Clone, Default)]
struct AppsRegistry {
    api_key: Option<Arc<str>>,
    apps: Arc<Vec<AppEntry>>,
}

impl AppsRegistry {
    fn new(apps: Vec<AppEntry>) -> Self {
        Self {
            api_key: None,
            apps: Arc::new(apps),
        }
    }

    #[cfg(test)]
    fn with_api_key(mut self, api_key: impl Into<Arc<str>>) -> Self {
        self.api_key = Some(api_key.into());
        self
    }

    fn resolve(&self, name: &str) -> Option<&AppEntry> {
        self.apps.iter().find(|app| app.name == name)
    }
}

fn registry_from_env() -> AppsRegistry {
    let api_key = non_empty_env(APP_PROXY_API_KEY_ENV).map(Arc::<str>::from);
    let mut registry =
        non_empty_env(APPS_JSON_ENV).map_or_else(AppsRegistry::default, |raw| parse_registry(&raw));
    registry.api_key = api_key;
    registry
}

/// Invalid configuration degrades to an empty registry (all apps 404) rather
/// than failing startup: the app plane is optional and must not take the API
/// down with it.
fn parse_registry(raw: &str) -> AppsRegistry {
    match serde_json::from_str::<Vec<AppEntry>>(raw) {
        Ok(apps) => AppsRegistry::new(apps),
        Err(error) => {
            tracing::error!(env = APPS_JSON_ENV, %error, "invalid apps registry JSON; app proxy registry is empty");
            AppsRegistry::default()
        }
    }
}

async fn proxy_app_root(
    Extension(registry): Extension<AppsRegistry>,
    Path(name): Path<String>,
    RawQuery(query): RawQuery,
    method: Method,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    forward_to_app(
        &registry,
        &name,
        "",
        query.as_deref(),
        method,
        &headers,
        body,
    )
    .await
}

async fn proxy_app_path(
    Extension(registry): Extension<AppsRegistry>,
    Path((name, path)): Path<(String, String)>,
    RawQuery(query): RawQuery,
    method: Method,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    forward_to_app(
        &registry,
        &name,
        &path,
        query.as_deref(),
        method,
        &headers,
        body,
    )
    .await
}

async fn forward_to_app(
    registry: &AppsRegistry,
    name: &str,
    path: &str,
    query: Option<&str>,
    method: Method,
    headers: &HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    authorize_app_proxy(registry, headers)?;
    let app = registry
        .resolve(name)
        .ok_or_else(|| ApiError::NotFound(format!("unknown app: {name}")))?;

    let mut url = format!("{}/{path}", app.url.trim_end_matches('/'));
    if let Some(query) = query {
        url.push('?');
        url.push_str(query);
    }

    let identity = HeaderValue::from_str(&app.name)
        .map_err(|_| ApiError::Internal(format!("app name {:?} is not header-safe", app.name)))?;

    let mut request = HTTP_CLIENT.request(method, &url);
    for (header_name, value) in headers {
        if forward_request_header(header_name) {
            request = request.header(header_name, value);
        }
    }
    let upstream = request
        .header(APP_IDENTITY_HEADER, identity)
        .body(reqwest::Body::wrap_stream(body.into_data_stream()))
        .send()
        .await
        .map_err(|error| {
            ApiError::BadGateway(format!("app '{name}' upstream request failed: {error}"))
        })?;

    let mut builder = Response::builder().status(upstream.status());
    for (header_name, value) in upstream.headers() {
        if !hop_by_hop(header_name) {
            builder = builder.header(header_name, value);
        }
    }
    builder
        .body(Body::from_stream(upstream.bytes_stream()))
        .map_err(|error| ApiError::Internal(format!("failed to build app proxy response: {error}")))
}

fn authorize_app_proxy(registry: &AppsRegistry, headers: &HeaderMap) -> Result<(), ApiError> {
    let expected = registry
        .api_key
        .as_deref()
        .ok_or_else(|| ApiError::Unauthorized("app proxy API key is not configured".to_owned()))?;
    let actual = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::Unauthorized("missing app proxy bearer token".to_owned()))?;
    if constant_time_eq(actual.as_bytes(), expected.as_bytes()) {
        Ok(())
    } else {
        Err(ApiError::Unauthorized(
            "invalid app proxy bearer token".to_owned(),
        ))
    }
}

fn constant_time_eq(actual: &[u8], expected: &[u8]) -> bool {
    use subtle::ConstantTimeEq;

    actual.ct_eq(expected).into()
}

/// Inbound credentials are stripped so apps only ever trust `x-centaur-app`;
/// `host` and framing headers are recomputed for the upstream connection.
fn forward_request_header(name: &HeaderName) -> bool {
    !(hop_by_hop(name)
        || *name == header::AUTHORIZATION
        || *name == header::COOKIE
        || *name == header::HOST
        || *name == header::CONTENT_LENGTH
        || *name == X_API_KEY
        || *name == APP_IDENTITY_HEADER)
}

fn hop_by_hop(name: &HeaderName) -> bool {
    *name == header::CONNECTION
        || *name == header::TRANSFER_ENCODING
        || *name == KEEP_ALIVE
        || *name == header::PROXY_AUTHENTICATE
        || *name == header::PROXY_AUTHORIZATION
        || *name == header::TE
        || *name == header::TRAILER
        || *name == header::UPGRADE
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use axum::{
        Json, Router,
        body::{Body, Bytes, to_bytes},
        http::{HeaderMap, Method, Request, StatusCode, Uri},
    };
    use serde_json::{Value, json};
    use tower::ServiceExt;

    use super::{AppEntry, AppsRegistry, apps_proxy_router_with_registry, parse_registry};
    use crate::routes::AppState;

    async fn echo(method: Method, uri: Uri, headers: HeaderMap, body: Bytes) -> Json<Value> {
        let headers: BTreeMap<String, String> = headers
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_owned(),
                    String::from_utf8_lossy(value.as_bytes()).into_owned(),
                )
            })
            .collect();
        Json(json!({
            "method": method.as_str(),
            "path": uri.path(),
            "query": uri.query(),
            "headers": headers,
            "body": String::from_utf8_lossy(&body),
        }))
    }

    async fn spawn_stub_upstream() -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new().fallback(echo);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        addr
    }

    fn proxy_router(upstream_url: String) -> Router {
        apps_proxy_router_with_registry(
            AppsRegistry::new(vec![AppEntry {
                name: "omp-stats".to_owned(),
                url: upstream_url,
            }])
            .with_api_key("secret"),
        )
        .with_state(AppState::unready())
    }

    async fn json_body(response: axum::response::Response) -> Value {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn forwards_path_query_body_and_rewrites_identity_headers() {
        let addr = spawn_stub_upstream().await;
        let app = proxy_router(format!("http://{addr}"));

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/apps/omp-stats/some/nested/path?x=1&y=two")
                    .header("authorization", "Bearer secret")
                    .header("cookie", "session=abc")
                    .header("x-api-key", "key123")
                    .header("x-centaur-app", "spoofed")
                    .header("x-custom", "keep-me")
                    .body(Body::from("hello upstream"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["method"], "POST");
        assert_eq!(body["path"], "/some/nested/path");
        assert_eq!(body["query"], "x=1&y=two");
        assert_eq!(body["body"], "hello upstream");
        let headers = body["headers"].as_object().unwrap();
        assert!(!headers.contains_key("authorization"));
        assert!(!headers.contains_key("cookie"));
        assert!(!headers.contains_key("x-api-key"));
        assert_eq!(headers["x-centaur-app"], "omp-stats");
        assert_eq!(headers["x-custom"], "keep-me");
    }

    #[tokio::test]
    async fn forwards_app_root_without_path() {
        let addr = spawn_stub_upstream().await;
        let app = proxy_router(format!("http://{addr}"));

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/apps/omp-stats")
                    .header("authorization", "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["method"], "GET");
        assert_eq!(body["path"], "/");
        assert_eq!(body["query"], Value::Null);
    }

    #[tokio::test]
    async fn forwards_app_root_with_trailing_slash() {
        let addr = spawn_stub_upstream().await;
        let app = proxy_router(format!("http://{addr}"));

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/apps/omp-stats/")
                    .header("authorization", "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["path"], "/");
    }

    #[tokio::test]
    async fn preserves_request_method() {
        let addr = spawn_stub_upstream().await;

        for method in [
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
        ] {
            let app = proxy_router(format!("http://{addr}"));
            let response = app
                .oneshot(
                    Request::builder()
                        .method(method.clone())
                        .uri("/apps/omp-stats/echo")
                        .header("authorization", "Bearer secret")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();

            assert_eq!(response.status(), StatusCode::OK);
            let body = json_body(response).await;
            assert_eq!(body["method"], method.as_str());
        }
    }

    #[tokio::test]
    async fn unknown_app_is_not_found() {
        let addr = spawn_stub_upstream().await;
        let app = proxy_router(format!("http://{addr}"));

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/apps/nope/anything")
                    .header("authorization", "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = json_body(response).await;
        assert_eq!(body["ok"], false);
        assert_eq!(body["error"], "unknown app: nope");
    }

    #[tokio::test]
    async fn empty_registry_is_not_found() {
        let app = apps_proxy_router_with_registry(AppsRegistry::default().with_api_key("secret"))
            .with_state(AppState::unready());

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/apps/omp-stats/anything")
                    .header("authorization", "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = json_body(response).await;
        assert_eq!(body["ok"], false);
    }

    #[tokio::test]
    async fn upstream_down_is_bad_gateway() {
        // Bind then drop: the port is allocated but nothing listens, so the
        // proxy sees connection refused.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);

        let app = proxy_router(format!("http://{addr}"));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/apps/omp-stats/anything")
                    .header("authorization", "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = json_body(response).await;
        assert_eq!(body["ok"], false);
    }

    #[tokio::test]
    async fn rejects_missing_or_invalid_proxy_credentials() {
        let addr = spawn_stub_upstream().await;

        for authorization in [None, Some("Bearer wrong")] {
            let app = proxy_router(format!("http://{addr}"));
            let mut request = Request::builder().uri("/apps/omp-stats/");
            if let Some(value) = authorization {
                request = request.header("authorization", value);
            }
            let response = app
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();

            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
    }

    #[test]
    fn invalid_registry_json_parses_to_empty() {
        let registry = parse_registry("not json at all");
        assert!(registry.apps.is_empty());
        let registry = parse_registry(r#"{"name":"not-an-array"}"#);
        assert!(registry.apps.is_empty());
    }

    #[test]
    fn registry_resolves_by_exact_name() {
        let registry = parse_registry(
            r#"[{"name":"omp-stats","url":"http://svc:8080"},{"name":"other","url":"http://o:1"}]"#,
        );
        assert_eq!(
            registry.resolve("omp-stats").unwrap().url,
            "http://svc:8080"
        );
        assert!(registry.resolve("omp-stat").is_none());
        assert!(registry.resolve("OMP-STATS").is_none());
    }
}
