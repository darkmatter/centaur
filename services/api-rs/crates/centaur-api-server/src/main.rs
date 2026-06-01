use std::{collections::BTreeMap, env, net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};

use centaur_api_server::{SandboxRuntime, build_router_with_runtime};
use centaur_iron_proxy::{SourceKind, SourcePolicy, discover_fragment_files, load_fragment_files};
use centaur_sandbox_agent_k8s::{
    AgentSandboxBackend, AgentSandboxConfig, IronProxyPodConfig, StateVolumeConfig,
};
use centaur_sandbox_core::{Mount, MountKind, SandboxSpec};
use centaur_sandbox_local::LocalSandboxBackend;
use centaur_session_core::ThreadKey;
use centaur_session_runtime::SandboxWorkloadMode;
use centaur_session_sqlx::PgSessionStore;
use clap::{Parser, ValueEnum};
use thiserror::Error;
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::{EnvFilter, fmt as tracing_fmt};

const SANDBOX_REPOS_MOUNT_PATH: &str = "/home/agent/github";

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
            config.image_pull_policy = args
                .session_sandbox_image_pull_policy
                .clone()
                .or_else(|| nonempty_env("KUBERNETES_AGENT_IMAGE_PULL_POLICY"));
            config.image_pull_secrets = sandbox_image_pull_secrets_from_env();
            config.runtime_class_name = nonempty_env("SESSION_SANDBOX_RUNTIME_CLASS_NAME")
                .or_else(|| nonempty_env("KUBERNETES_SANDBOX_RUNTIME_CLASS_NAME"));
            config.service_account_name = nonempty_env("SESSION_SANDBOX_SERVICE_ACCOUNT_NAME")
                .or_else(|| nonempty_env("KUBERNETES_SANDBOX_SERVICE_ACCOUNT_NAME"));
            config.state_volume = sandbox_state_volume_from_env();
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
            let backend = Arc::new(AgentSandboxBackend::new(client, config));

            Ok(container_sandbox_runtime(backend, args))
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

fn container_sandbox_runtime(backend: Arc<AgentSandboxBackend>, args: &Args) -> SandboxRuntime {
    if args.session_sandbox_workload == SandboxWorkloadKind::CodexAppServer {
        if let Some(repos_path) = sandbox_repos_path_from_env() {
            let image = args
                .session_sandbox_image
                .clone()
                .unwrap_or_else(|| default_sandbox_image(args.session_sandbox_workload).to_owned());
            let env_template = codex_app_server_env_template(args);
            return SandboxRuntime::backend_with_spec_factory(
                backend,
                move |thread_key, _execution_id| {
                    codex_app_server_spec(
                        &image,
                        thread_key,
                        &env_template,
                        Some(repos_path.as_str()),
                    )
                },
            );
        }
    }

    SandboxRuntime::backend_with_workload(backend, container_workload_mode(args))
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
    let fragment_paths = iron_proxy_fragment_paths()?;
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
        .or_else(|_| env::var("KUBERNETES_AGENT_IMAGE_PULL_POLICY"))
        .ok();
    config.image_pull_secrets = sandbox_image_pull_secrets_from_env();
    config.source_policy = SourcePolicy::from_env();
    if let Some(secret_name) = env::var("SESSION_SANDBOX_IRON_PROXY_ENV_SECRET")
        .or_else(|_| env::var("KUBERNETES_SECRET_ENV_NAME"))
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        config.secret_env_name = Some(secret_name.clone());
        config.secret_env_prefix = env::var("SESSION_SANDBOX_IRON_PROXY_ENV_SECRET_PREFIX")
            .or_else(|_| env::var("KUBERNETES_SECRET_ENV_PREFIX"))
            .unwrap_or_default();
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
    config.token_broker_name = env::var("SESSION_SANDBOX_IRON_BROKER_NAME")
        .or_else(|_| env::var("KUBERNETES_TOKEN_BROKER_NAME"))
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    config.token_broker_configmap_name = env::var("SESSION_SANDBOX_IRON_BROKER_CONFIGMAP_NAME")
        .or_else(|_| env::var("KUBERNETES_TOKEN_BROKER_CONFIGMAP_NAME"))
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    Ok(Some(config))
}

fn iron_proxy_fragment_paths() -> Result<Vec<PathBuf>, ServerError> {
    let mut paths = split_env_paths("SESSION_SANDBOX_IRON_PROXY_FRAGMENT_PATHS");
    let mut dirs = split_env_paths("SESSION_SANDBOX_IRON_PROXY_FRAGMENT_DIRS");
    if dirs.is_empty() {
        dirs.extend(split_env_paths("TOOL_DIRS"));
    }
    paths.extend(discover_fragment_files(&dirs)?);
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn split_env_paths(name: &str) -> Vec<PathBuf> {
    env::var(name)
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

fn sandbox_repos_path_from_env() -> Option<String> {
    nonempty_env("SESSION_SANDBOX_REPOS_PATH").or_else(|| nonempty_env("REPOS_PATH"))
}

fn sandbox_image_pull_secrets_from_env() -> Vec<String> {
    env::var("SESSION_SANDBOX_IMAGE_PULL_SECRETS")
        .or_else(|_| env::var("KUBERNETES_SANDBOX_IMAGE_PULL_SECRETS"))
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn sandbox_state_volume_from_env() -> Option<StateVolumeConfig> {
    if !env_bool("SESSION_SANDBOX_STATE_VOLUME_ENABLED")
        && !env_bool("KUBERNETES_SANDBOX_STATE_VOLUME_ENABLED")
    {
        return None;
    }
    let mount_path = nonempty_env("SESSION_SANDBOX_STATE_MOUNT_PATH")
        .or_else(|| nonempty_env("KUBERNETES_SANDBOX_STATE_MOUNT_PATH"))
        .unwrap_or_else(|| "/home/agent/state".to_owned());
    let size = nonempty_env("SESSION_SANDBOX_STATE_VOLUME_SIZE")
        .or_else(|| nonempty_env("KUBERNETES_SANDBOX_STATE_VOLUME_SIZE"))
        .unwrap_or_else(|| "10Gi".to_owned());
    let mut config = StateVolumeConfig::new(mount_path, size);
    if let Some(storage_class_name) = nonempty_env("SESSION_SANDBOX_STATE_VOLUME_STORAGE_CLASS")
        .or_else(|| nonempty_env("KUBERNETES_SANDBOX_STATE_VOLUME_STORAGE_CLASS"))
    {
        config = config.storage_class_name(storage_class_name);
    }
    Some(config)
}

fn nonempty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn codex_app_server_spec(
    image: &str,
    thread_key: &ThreadKey,
    env_template: &[(String, String)],
    repos_path: Option<&str>,
) -> SandboxSpec {
    let mut spec = SandboxSpec::new(image).env("CENTAUR_THREAD_KEY", thread_key.as_str());
    if let Some(repos_path) = repos_path {
        spec = spec.mount(
            Mount::new(
                MountKind::Bind {
                    source_path: repos_path.to_owned(),
                },
                SANDBOX_REPOS_MOUNT_PATH,
            )
            .read_only(),
        );
    }
    for (name, value) in env_template {
        spec = spec.env(name.clone(), value.clone());
    }
    spec
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_app_server_spec_mounts_repos_path_read_only() {
        let thread_key = ThreadKey::parse("test:thread").unwrap();

        let spec = codex_app_server_spec(
            "centaur-agent:latest",
            &thread_key,
            &[("CENTAUR_API_URL".to_owned(), "http://api:8000".to_owned())],
            Some("/host/github"),
        );

        assert_eq!(spec.mounts.len(), 1);
        assert_eq!(spec.mounts[0].target_path, SANDBOX_REPOS_MOUNT_PATH);
        assert!(spec.mounts[0].read_only);
        assert_eq!(
            spec.mounts[0].kind,
            MountKind::Bind {
                source_path: "/host/github".to_owned(),
            }
        );
        assert!(
            spec.env
                .iter()
                .any(|env| { env.name == "CENTAUR_API_URL" && env.value == "http://api:8000" })
        );
    }

    #[test]
    fn codex_app_server_spec_omits_repos_mount_when_unset() {
        let thread_key = ThreadKey::parse("test:thread").unwrap();

        let spec = codex_app_server_spec("centaur-agent:latest", &thread_key, &[], None);

        assert!(spec.mounts.is_empty());
        assert!(
            spec.env
                .iter()
                .any(|env| { env.name == "CENTAUR_THREAD_KEY" && env.value == "test:thread" })
        );
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
