use std::{env, net::SocketAddr, sync::Arc, time::Duration};

use centaur_api_server::{SandboxRuntime, build_router_with_runtime};
use centaur_sandbox_agent_k8s::{AgentSandboxBackend, AgentSandboxConfig};
use centaur_sandbox_core::SandboxSpec;
use centaur_sandbox_local::LocalSandboxBackend;
use centaur_session_sqlx::PgSessionStore;
use thiserror::Error;
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::{EnvFilter, fmt};

#[tokio::main]
async fn main() -> Result<(), ServerError> {
    init_tracing();

    let database_url = env::var("DATABASE_URL").map_err(|_| ServerError::MissingDatabaseUrl)?;
    let bind_addr = env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".to_owned());
    let bind_addr: SocketAddr = bind_addr.parse()?;
    let run_migrations = env::var("RUN_MIGRATIONS")
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes"))
        .unwrap_or(false);

    let store = PgSessionStore::connect(&database_url).await?;
    if run_migrations {
        store.run_migrations().await?;
    }
    let sandbox_runtime = sandbox_runtime_from_env().await?;

    let listener = TcpListener::bind(bind_addr).await?;
    info!(%bind_addr, "starting centaur api-rs server");

    axum::serve(listener, build_router_with_runtime(store, sandbox_runtime))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    fmt().with_env_filter(filter).json().init();
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

async fn sandbox_runtime_from_env() -> Result<SandboxRuntime, ServerError> {
    let backend = env::var("SESSION_SANDBOX_BACKEND").unwrap_or_else(|_| "mock".to_owned());
    match backend.as_str() {
        "mock" => Ok(SandboxRuntime::Mock),
        "local" => Ok(SandboxRuntime::backend(
            Arc::new(LocalSandboxBackend::new()),
            local_mock_app_server_spec(),
        )),
        "agent-k8s" => {
            let namespace = env::var("SESSION_SANDBOX_K8S_NAMESPACE")
                .unwrap_or_else(|_| "centaur-sandbox-e2e".to_owned());
            let image =
                env::var("SESSION_SANDBOX_IMAGE").unwrap_or_else(|_| "busybox:1.36".to_owned());
            let mut config = AgentSandboxConfig::new(namespace);
            config.ready_timeout = Duration::from_secs(
                env::var("SESSION_SANDBOX_READY_TIMEOUT_SECS")
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(90),
            );

            let backend = if let Ok(context) = env::var("SESSION_SANDBOX_K8S_CONTEXT") {
                let kube_config = kube::Config::from_kubeconfig(&kube::config::KubeConfigOptions {
                    context: Some(context),
                    ..kube::config::KubeConfigOptions::default()
                })
                .await?;
                AgentSandboxBackend::new(kube::Client::try_from(kube_config)?, config)
            } else {
                AgentSandboxBackend::try_default(config.namespace.clone()).await?
            };

            Ok(SandboxRuntime::backend(
                Arc::new(backend),
                agent_k8s_mock_app_server_spec(&image),
            ))
        }
        other => Err(ServerError::InvalidSandboxBackend(other.to_owned())),
    }
}

fn local_mock_app_server_spec() -> SandboxSpec {
    SandboxSpec::new("/bin/sh")
        .command(["/bin/sh", "-lc"])
        .args([mock_app_server_script()])
}

fn agent_k8s_mock_app_server_spec(image: &str) -> SandboxSpec {
    SandboxSpec::new(image)
        .command(["/bin/sh", "-lc"])
        .args([mock_app_server_script()])
}

fn mock_app_server_script() -> &'static str {
    r#"while IFS= read -r line; do
printf '%s\n' '{"type":"system","subtype":"wrapper_heartbeat","phase":"startup"}'
sleep 0.2
printf '%s\n' '{"type":"system","subtype":"wrapper_heartbeat","phase":"app_server_started"}'
sleep 0.2
printf '%s\n' '{"type":"thread.started","thread_id":"mock-codex-thread"}'
sleep 0.2
turn_index=1
while [ "$turn_index" -le 3 ]; do
  turn_id="mock-turn-$turn_index"
  printf '{"type":"turn.started","turn_id":"%s"}\n' "$turn_id"
  sleep 0.2
  printf '{"type":"item.agentMessage.delta","turnId":"%s","session_id":"mock-codex-thread","delta":"PONG %s"}\n' "$turn_id" "$turn_index"
  sleep 0.2
  printf '{"type":"turn.completed","turn":{"id":"%s"},"usage":{"input_tokens":0,"output_tokens":1}}\n' "$turn_id"
  sleep 0.2
  turn_index=$((turn_index + 1))
done
done"#
}

#[derive(Debug, Error)]
enum ServerError {
    #[error("DATABASE_URL is required")]
    MissingDatabaseUrl,
    #[error("unknown SESSION_SANDBOX_BACKEND {0:?}; expected mock, local, or agent-k8s")]
    InvalidSandboxBackend(String),
    #[error(transparent)]
    AddrParse(#[from] std::net::AddrParseError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Store(#[from] centaur_session_sqlx::SessionStoreError),
    #[error(transparent)]
    Sandbox(#[from] centaur_sandbox_core::SandboxError),
    #[error(transparent)]
    KubeConfig(#[from] kube::config::KubeconfigError),
    #[error(transparent)]
    KubeInferConfig(#[from] kube::config::InferConfigError),
    #[error(transparent)]
    Kube(#[from] kube::Error),
}
