use std::{collections::BTreeMap, env, net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};

use centaur_api_server::{SandboxRuntime, build_router_with_runtime};
use centaur_iron_proxy::{SourceKind, SourcePolicy, load_fragment_files};
use centaur_sandbox_agent_k8s::{AgentSandboxBackend, AgentSandboxConfig, IronProxyPodConfig};
use centaur_sandbox_local::LocalSandboxBackend;
use centaur_session_runtime::SandboxWorkloadMode;
use centaur_session_sqlx::PgSessionStore;
use clap::{Parser, ValueEnum};
use thiserror::Error;
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::{EnvFilter, fmt as tracing_fmt};

#[tokio::main]
async fn main() -> Result<(), ServerError> {
    init_tracing();

    let args = Args::parse();

    let store = PgSessionStore::connect(&args.database_url).await?;
    if args.run_migrations {
        store.run_migrations().await?;
    }
    let sandbox_runtime = sandbox_runtime_from_args(&args).await?;

    let listener = TcpListener::bind(args.bind_addr).await?;
    info!(bind_addr = %args.bind_addr, "starting centaur api-rs server");

    axum::serve(listener, build_router_with_runtime(store, sandbox_runtime))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_fmt().with_env_filter(filter).json().init();
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

async fn sandbox_runtime_from_args(args: &Args) -> Result<SandboxRuntime, ServerError> {
    match args.session_sandbox_backend {
        SandboxBackendKind::Local => Ok(SandboxRuntime::backend_with_workload(
            Arc::new(LocalSandboxBackend::new()),
            local_workload_mode(args)?,
        )),
        SandboxBackendKind::AgentK8s => {
            let mut config = AgentSandboxConfig::new(args.session_sandbox_k8s_namespace.clone());
            config.image_pull_policy = args.session_sandbox_image_pull_policy.clone();
            config.ready_timeout = Duration::from_secs(args.session_sandbox_ready_timeout_secs);
            config.iron_proxy = iron_proxy_config_from_env()?;

            let client = if let Some(context) = args.session_sandbox_k8s_context.as_deref() {
                let kube_config = kube::Config::from_kubeconfig(&kube::config::KubeConfigOptions {
                    context: Some(context.to_owned()),
                    ..kube::config::KubeConfigOptions::default()
                })
                .await?;
                kube::Client::try_from(kube_config)?
            } else {
                kube::Client::try_default().await?
            };
            let backend = AgentSandboxBackend::new(client, config);

            Ok(SandboxRuntime::backend_with_workload(
                Arc::new(backend),
                container_workload_mode(args),
            ))
        }
    }
}

fn local_workload_mode(args: &Args) -> Result<SandboxWorkloadMode, ServerError> {
    match args.session_sandbox_workload {
        SandboxWorkloadKind::Mock => Ok(SandboxWorkloadMode::mock_app_server(
            args.session_sandbox_image
                .clone()
                .unwrap_or_else(|| "local-mock-app-server".to_owned()),
        )),
        SandboxWorkloadKind::CodexAppServer => Err(ServerError::UnsupportedConfig(
            "codex-app-server workload requires --session-sandbox-backend agent-k8s".to_owned(),
        )),
    }
}

fn container_workload_mode(args: &Args) -> SandboxWorkloadMode {
    let image = args
        .session_sandbox_image
        .clone()
        .unwrap_or_else(|| default_sandbox_image(args.session_sandbox_workload).to_owned());
    match args.session_sandbox_workload {
        SandboxWorkloadKind::Mock => SandboxWorkloadMode::mock_app_server(image),
        SandboxWorkloadKind::CodexAppServer => {
            SandboxWorkloadMode::codex_app_server(image, codex_app_server_env_template(args))
        }
    }
}

#[derive(Debug, Parser)]
#[command(about = "Run the Centaur API Rust session control plane")]
struct Args {
    #[arg(long, env = "DATABASE_URL")]
    database_url: String,
    #[arg(long, env = "BIND_ADDR", default_value = "127.0.0.1:8080")]
    bind_addr: SocketAddr,
    #[arg(long, env = "RUN_MIGRATIONS", default_value_t = false)]
    run_migrations: bool,
    #[arg(
        long,
        env = "SESSION_SANDBOX_BACKEND",
        value_enum,
        default_value = "local"
    )]
    session_sandbox_backend: SandboxBackendKind,
    #[arg(
        long,
        env = "SESSION_SANDBOX_WORKLOAD",
        value_enum,
        default_value = "mock"
    )]
    session_sandbox_workload: SandboxWorkloadKind,
    #[arg(
        long,
        env = "SESSION_SANDBOX_K8S_NAMESPACE",
        default_value = "centaur-sandbox-e2e"
    )]
    session_sandbox_k8s_namespace: String,
    #[arg(long, env = "SESSION_SANDBOX_IMAGE")]
    session_sandbox_image: Option<String>,
    #[arg(long, env = "SESSION_SANDBOX_IMAGE_PULL_POLICY")]
    session_sandbox_image_pull_policy: Option<String>,
    #[arg(long, env = "SESSION_SANDBOX_READY_TIMEOUT_SECS", default_value_t = 90)]
    session_sandbox_ready_timeout_secs: u64,
    #[arg(long, env = "SESSION_SANDBOX_K8S_CONTEXT")]
    session_sandbox_k8s_context: Option<String>,
    #[arg(long, env = "SESSION_SANDBOX_CENTAUR_API_URL")]
    session_sandbox_centaur_api_url: Option<String>,
    #[arg(long, env = "CENTAUR_API_URL")]
    centaur_api_url: Option<String>,
    #[arg(long, env = "SESSION_SANDBOX_CENTAUR_API_KEY")]
    session_sandbox_centaur_api_key: Option<String>,
    #[arg(long, env = "CENTAUR_API_KEY")]
    centaur_api_key: Option<String>,
    #[arg(long, env = "SESSION_SANDBOX_PASSTHROUGH_ENV", value_delimiter = ',')]
    session_sandbox_passthrough_env: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum SandboxBackendKind {
    Local,
    #[value(name = "agent-k8s")]
    AgentK8s,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum SandboxWorkloadKind {
    Mock,
    #[value(name = "codex-app-server")]
    CodexAppServer,
}

fn default_sandbox_image(workload: SandboxWorkloadKind) -> &'static str {
    match workload {
        SandboxWorkloadKind::Mock => "busybox:1.36",
        SandboxWorkloadKind::CodexAppServer => "centaur-agent:latest",
    }
}

fn iron_proxy_config_from_env() -> Result<Option<IronProxyPodConfig>, ServerError> {
    let fragment_paths = iron_proxy_fragment_paths();
    if !env_bool("SESSION_SANDBOX_IRON_PROXY_ENABLED") && fragment_paths.is_empty() {
        return Ok(None);
    }
    let ca_cert_secret_name = env::var("SESSION_SANDBOX_IRON_PROXY_CA_CERT_SECRET_NAME")
        .or_else(|_| env::var("KUBERNETES_FIREWALL_CA_SECRET_NAME"))
        .map_err(|_| ServerError::MissingIronProxyCaSecret)?;
    let ca_key_secret_name = env::var("SESSION_SANDBOX_IRON_PROXY_CA_KEY_SECRET_NAME")
        .or_else(|_| env::var("KUBERNETES_FIREWALL_CA_KEY_SECRET_NAME"))
        .map_err(|_| ServerError::MissingIronProxyCaSecret)?;
    let image = env::var("SESSION_SANDBOX_IRON_PROXY_IMAGE")
        .or_else(|_| env::var("KUBERNETES_IRON_PROXY_IMAGE"))
        .unwrap_or_else(|_| "centaur-iron-proxy:latest".to_owned());
    let mut config = IronProxyPodConfig::new(image, ca_cert_secret_name, ca_key_secret_name)
        .with_fragments(load_fragment_files(&fragment_paths)?);
    config.image_pull_policy = env::var("SESSION_SANDBOX_IRON_PROXY_IMAGE_PULL_POLICY")
        .or_else(|_| env::var("KUBERNETES_IRON_PROXY_IMAGE_PULL_POLICY"))
        .ok();
    config.source_policy = SourcePolicy::from_env();
    if let Some(secret_name) = env::var("SESSION_SANDBOX_IRON_PROXY_ENV_SECRET")
        .or_else(|_| env::var("KUBERNETES_SECRET_ENV_NAME"))
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        config.env_from_secret_names.push(secret_name);
    }
    if matches!(config.source_policy.kind, SourceKind::OnePassword) {
        if let Some(secret_name) = env::var("KUBERNETES_BOOTSTRAP_SECRET_NAME")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
        {
            config.env_from_secret_names.push(secret_name);
        }
    }
    if let Ok(app_name) = env::var("KUBERNETES_OP_CONNECT_APP_NAME") {
        config.op_connect_app_name = app_name;
    }
    config.op_connect_port = env::var("KUBERNETES_OP_CONNECT_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .or_else(|| {
            env::var("KUBERNETES_OP_CONNECT_HOST")
                .ok()
                .and_then(|value| parse_host_port(&value))
        })
        .unwrap_or(config.op_connect_port);
    if let Ok(selector) = env::var("KUBERNETES_API_POD_LABEL_SELECTOR") {
        let labels = parse_label_selector(&selector);
        if !labels.is_empty() {
            config.api_pod_labels = labels;
        }
    }
    config.harness_auth_modes = harness_auth_modes_from_env();
    push_optional_proxy_env(
        &mut config.extra_env,
        "OP_CONNECT_HOST",
        env::var("SESSION_SANDBOX_OP_CONNECT_HOST")
            .or_else(|_| env::var("KUBERNETES_OP_CONNECT_HOST"))
            .ok(),
    );
    push_optional_proxy_env(
        &mut config.extra_env,
        "IRON_BROKER_URL",
        env::var("SESSION_SANDBOX_IRON_BROKER_URL")
            .or_else(|_| env::var("KUBERNETES_TOKEN_BROKER_URL"))
            .ok(),
    );
    Ok(Some(config))
}

fn iron_proxy_fragment_paths() -> Vec<PathBuf> {
    env::var("SESSION_SANDBOX_IRON_PROXY_FRAGMENT_PATHS")
        .unwrap_or_default()
        .split([',', ':'])
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .collect()
}

fn harness_auth_modes_from_env() -> BTreeMap<String, String> {
    let mut modes = BTreeMap::new();
    if let Ok(mode) = env::var("CODEX_AUTH_MODE") {
        modes.insert("codex".to_owned(), mode);
    }
    if let Ok(mode) = env::var("CLAUDE_CODE_AUTH_MODE") {
        modes.insert("claude-code".to_owned(), mode);
    }
    modes
}

fn push_optional_proxy_env(envs: &mut BTreeMap<String, String>, name: &str, value: Option<String>) {
    if let Some(value) = value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        envs.insert(name.to_owned(), value);
    }
}

fn parse_host_port(value: &str) -> Option<u16> {
    value.rsplit_once(':')?.1.parse().ok()
}

fn parse_label_selector(value: &str) -> BTreeMap<String, String> {
    value
        .split(',')
        .filter_map(|item| {
            let (key, value) = item.split_once('=')?;
            let key = key.trim();
            let value = value.trim();
            (!key.is_empty() && !value.is_empty()).then(|| (key.to_owned(), value.to_owned()))
        })
        .collect()
}

fn env_bool(name: &str) -> bool {
    env::var(name)
        .map(|value| matches!(value.trim(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
}
fn codex_app_server_env_template(args: &Args) -> Vec<(String, String)> {
    let mut envs = Vec::new();
    push_env(
        &mut envs,
        "CENTAUR_API_URL",
        args.session_sandbox_centaur_api_url
            .as_deref()
            .or(args.centaur_api_url.as_deref())
            .unwrap_or("http://api:8000")
            .to_owned(),
    );
    if let Some(api_key) = args
        .session_sandbox_centaur_api_key
        .as_deref()
        .or(args.centaur_api_key.as_deref())
    {
        push_env(&mut envs, "CENTAUR_API_KEY", api_key.to_owned());
    }
    for name in ["CLAUDE_CODE_AUTH_MODE", "CODEX_AUTH_MODE"] {
        if let Ok(value) = env::var(name) {
            push_env(&mut envs, name, value);
        }
    }

    for name in &args.session_sandbox_passthrough_env {
        if let Ok(value) = env::var(name) {
            push_env(&mut envs, name, value);
        }
    }

    envs
}

fn push_env(envs: &mut Vec<(String, String)>, name: &str, value: String) {
    if let Some((_, existing_value)) = envs
        .iter_mut()
        .find(|(existing_name, _)| existing_name == name)
    {
        *existing_value = value;
    } else {
        envs.push((name.to_owned(), value));
    }
}

#[derive(Debug, Error)]
enum ServerError {
    #[error(
        "SESSION_SANDBOX_IRON_PROXY_CA_CERT_SECRET_NAME/KUBERNETES_FIREWALL_CA_SECRET_NAME and SESSION_SANDBOX_IRON_PROXY_CA_KEY_SECRET_NAME/KUBERNETES_FIREWALL_CA_KEY_SECRET_NAME are required when SESSION_SANDBOX_IRON_PROXY_ENABLED is set"
    )]
    MissingIronProxyCaSecret,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Store(#[from] centaur_session_sqlx::SessionStoreError),
    #[error(transparent)]
    IronProxy(#[from] centaur_iron_proxy::IronProxyConfigError),
    #[error(transparent)]
    KubeConfig(#[from] kube::config::KubeconfigError),
    #[error(transparent)]
    KubeInferConfig(#[from] kube::config::InferConfigError),
    #[error(transparent)]
    Kube(#[from] kube::Error),
    #[error("{0}")]
    UnsupportedConfig(String),
}
