use std::{collections::BTreeMap, env, net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};

use centaur_api_server::{SandboxRuntime, build_router_with_runtime};
use centaur_iron_proxy::{SourceKind, SourcePolicy, discover_fragment_files, load_fragment_files};
use centaur_sandbox_agent_k8s::{
    AgentSandboxBackend, AgentSandboxConfig, IronProxyPodConfig, StateVolumeConfig,
};
use centaur_sandbox_core::{Mount, MountKind};
use centaur_sandbox_local::LocalSandboxBackend;
use centaur_session_runtime::SandboxWorkloadMode;
use centaur_session_sqlx::PgSessionStore;
use clap::{Parser, ValueEnum};
use thiserror::Error;
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::{EnvFilter, fmt as tracing_fmt};

const SANDBOX_REPOS_MOUNT_PATH: &str = "/home/agent/github";
const DEFAULT_TOOL_BUILD_CACHE_MOUNT_PATH: &str = "/home/agent/.cache";

#[tokio::main]
async fn main() -> Result<(), ServerError> {
    let _ = rustls::crypto::ring::default_provider().install_default();
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
    match args.kubernetes_sandbox_backend {
        SandboxBackendKind::Local => Ok(SandboxRuntime::backend_with_workload(
            Arc::new(LocalSandboxBackend::new()),
            local_workload_mode(args)?,
        )),
        SandboxBackendKind::AgentK8s => {
            let mut config = agent_sandbox_config_from_args(args)?;
            config.ready_timeout = Duration::from_secs(args.kubernetes_sandbox_ready_timeout_s);

            let client = if let Some(context) = args.kubernetes_context.as_deref() {
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

            container_sandbox_runtime(backend, args)
        }
    }
}

fn local_workload_mode(args: &Args) -> Result<SandboxWorkloadMode, ServerError> {
    match args.kubernetes_sandbox_workload {
        SandboxWorkloadKind::Mock => Ok(SandboxWorkloadMode::mock_app_server(
            args.kubernetes_agent_image
                .clone()
                .unwrap_or_else(|| "local-mock-app-server".to_owned()),
        )),
        SandboxWorkloadKind::CodexAppServer => Err(ServerError::UnsupportedConfig(
            "codex-app-server workload requires --kubernetes-sandbox-backend agent-k8s".to_owned(),
        )),
    }
}

fn container_sandbox_runtime(
    backend: Arc<AgentSandboxBackend>,
    args: &Args,
) -> Result<SandboxRuntime, ServerError> {
    Ok(SandboxRuntime::backend_with_workload(
        backend,
        container_workload_mode(args)?,
    ))
}

fn container_workload_mode(args: &Args) -> Result<SandboxWorkloadMode, ServerError> {
    let image = args
        .kubernetes_agent_image
        .clone()
        .unwrap_or_else(|| default_sandbox_image(args.kubernetes_sandbox_workload).to_owned());
    match args.kubernetes_sandbox_workload {
        SandboxWorkloadKind::Mock => Ok(SandboxWorkloadMode::mock_app_server(image)),
        SandboxWorkloadKind::CodexAppServer => {
            let mut workload =
                SandboxWorkloadMode::codex_app_server(image, codex_app_server_env_template(args));
            if let Some(repos_path) = clean_optional_value(args.repos_path.as_deref()) {
                workload = workload.mount(
                    Mount::new(
                        MountKind::Bind {
                            source_path: repos_path,
                        },
                        SANDBOX_REPOS_MOUNT_PATH,
                    )
                    .read_only(),
                );
            }
            if let Some(cache_path) =
                clean_optional_value(args.kubernetes_tool_build_cache_host_path.as_deref())
            {
                workload = workload.mount(Mount::new(
                    MountKind::Bind {
                        source_path: cache_path,
                    },
                    tool_build_cache_mount_path(args),
                ));
            }
            Ok(workload)
        }
    }
}

#[derive(Debug, Parser)]
#[command(about = "Run the Centaur API Rust control plane")]
struct Args {
    #[arg(long, env = "DATABASE_URL")]
    database_url: String,
    #[arg(long, env = "BIND_ADDR", default_value = "127.0.0.1:8080")]
    bind_addr: SocketAddr,
    #[arg(long, env = "RUN_MIGRATIONS", default_value_t = false)]
    run_migrations: bool,
    #[arg(
        long,
        env = "KUBERNETES_SANDBOX_BACKEND",
        value_enum,
        default_value = "local"
    )]
    kubernetes_sandbox_backend: SandboxBackendKind,
    #[arg(
        long,
        env = "KUBERNETES_SANDBOX_WORKLOAD",
        value_enum,
        default_value = "mock"
    )]
    kubernetes_sandbox_workload: SandboxWorkloadKind,
    #[arg(
        long,
        env = "KUBERNETES_NAMESPACE",
        default_value = "centaur-sandbox-e2e"
    )]
    kubernetes_namespace: String,
    #[arg(long, env = "KUBERNETES_AGENT_IMAGE")]
    kubernetes_agent_image: Option<String>,
    #[arg(long, env = "KUBERNETES_AGENT_IMAGE_PULL_POLICY")]
    kubernetes_agent_image_pull_policy: Option<String>,
    #[arg(
        long,
        env = "KUBERNETES_SANDBOX_IMAGE_PULL_SECRETS",
        value_delimiter = ','
    )]
    kubernetes_sandbox_image_pull_secrets: Vec<String>,
    #[arg(long, env = "KUBERNETES_SANDBOX_READY_TIMEOUT_S", default_value_t = 90)]
    kubernetes_sandbox_ready_timeout_s: u64,
    #[arg(long, env = "KUBERNETES_CONTEXT")]
    kubernetes_context: Option<String>,
    #[arg(long, env = "KUBERNETES_SANDBOX_RUNTIME_CLASS_NAME")]
    kubernetes_sandbox_runtime_class_name: Option<String>,
    #[arg(long, env = "KUBERNETES_SANDBOX_SERVICE_ACCOUNT_NAME")]
    kubernetes_sandbox_service_account_name: Option<String>,
    #[arg(
        long,
        env = "KUBERNETES_SANDBOX_STATE_VOLUME_ENABLED",
        default_value_t = false
    )]
    kubernetes_sandbox_state_volume_enabled: bool,
    #[arg(long, env = "KUBERNETES_SANDBOX_STATE_MOUNT_PATH")]
    kubernetes_sandbox_state_mount_path: Option<String>,
    #[arg(long, env = "KUBERNETES_SANDBOX_STATE_VOLUME_SIZE")]
    kubernetes_sandbox_state_volume_size: Option<String>,
    #[arg(long, env = "KUBERNETES_SANDBOX_STATE_VOLUME_STORAGE_CLASS")]
    kubernetes_sandbox_state_volume_storage_class: Option<String>,
    #[arg(long, env = "REPOS_PATH")]
    repos_path: Option<String>,
    #[arg(long, env = "CENTAUR_OVERLAY_REPO")]
    centaur_overlay_repo: Option<String>,
    #[arg(long, env = "KUBERNETES_TOOL_BUILD_CACHE_HOST_PATH")]
    kubernetes_tool_build_cache_host_path: Option<String>,
    #[arg(
        long,
        env = "KUBERNETES_TOOL_BUILD_CACHE_MOUNT_PATH",
        default_value = DEFAULT_TOOL_BUILD_CACHE_MOUNT_PATH
    )]
    kubernetes_tool_build_cache_mount_path: String,
    #[arg(
        long,
        env = "KUBERNETES_TOOL_BUILD_CACHE_UV_LINK_MODE",
        default_value = "copy"
    )]
    kubernetes_tool_build_cache_uv_link_mode: String,
    #[arg(long, env = "CENTAUR_API_URL", default_value = "http://api:8000")]
    centaur_api_url: String,
    #[arg(long, env = "CENTAUR_API_KEY")]
    centaur_api_key: Option<String>,
    #[arg(
        long,
        env = "KUBERNETES_SANDBOX_PASSTHROUGH_ENV",
        value_delimiter = ','
    )]
    kubernetes_sandbox_passthrough_env: Vec<String>,
    #[arg(long, env = "CODEX_AUTH_MODE")]
    codex_auth_mode: Option<String>,
    #[arg(long, env = "CLAUDE_CODE_AUTH_MODE")]
    claude_code_auth_mode: Option<String>,
    #[arg(
        long,
        env = "KUBERNETES_SANDBOX_IRON_PROXY_MODE",
        value_enum,
        default_value = "auto"
    )]
    kubernetes_sandbox_iron_proxy_mode: IronProxyMode,
    #[arg(long, env = "KUBERNETES_IRON_PROXY_IMAGE")]
    kubernetes_iron_proxy_image: Option<String>,
    #[arg(long, env = "KUBERNETES_IRON_PROXY_IMAGE_PULL_POLICY")]
    kubernetes_iron_proxy_image_pull_policy: Option<String>,
    #[arg(
        long,
        env = "KUBERNETES_IRON_PROXY_FRAGMENT_PATHS",
        value_delimiter = ','
    )]
    kubernetes_iron_proxy_fragment_paths: Vec<PathBuf>,
    #[arg(
        long,
        env = "KUBERNETES_IRON_PROXY_FRAGMENT_DIRS",
        value_delimiter = ','
    )]
    kubernetes_iron_proxy_fragment_dirs: Vec<PathBuf>,
    #[arg(long, env = "TOOL_DIRS", value_delimiter = ':')]
    tool_dirs: Vec<PathBuf>,
    #[arg(long, env = "KUBERNETES_FIREWALL_CA_SECRET_NAME")]
    kubernetes_firewall_ca_secret_name: Option<String>,
    #[arg(long, env = "KUBERNETES_FIREWALL_CA_KEY_SECRET_NAME")]
    kubernetes_firewall_ca_key_secret_name: Option<String>,
    #[arg(long, env = "KUBERNETES_SECRET_ENV_NAME")]
    kubernetes_secret_env_name: Option<String>,
    #[arg(long, env = "KUBERNETES_SECRET_ENV_PREFIX")]
    kubernetes_secret_env_prefix: Option<String>,
    #[arg(long, env = "KUBERNETES_BOOTSTRAP_SECRET_NAME")]
    kubernetes_bootstrap_secret_name: Option<String>,
    #[arg(
        long,
        env = "KUBERNETES_FIREWALL_MANAGER_SECRET_SOURCE",
        value_enum,
        default_value = "env"
    )]
    kubernetes_firewall_manager_secret_source: IronProxySecretSourceArg,
    #[arg(long, env = "OP_VAULT")]
    op_vault: Option<String>,
    #[arg(
        long,
        env = "KUBERNETES_FIREWALL_MANAGER_SECRET_TTL",
        default_value = "10m"
    )]
    kubernetes_firewall_manager_secret_ttl: String,
    #[arg(
        long,
        env = "KUBERNETES_FIREWALL_MANAGER_TOKEN_BROKER_TTL",
        default_value = "1m"
    )]
    kubernetes_firewall_manager_token_broker_ttl: String,
    #[arg(long, env = "KUBERNETES_OP_CONNECT_HOST")]
    kubernetes_op_connect_host: Option<String>,
    #[arg(long, env = "KUBERNETES_OP_CONNECT_APP_NAME")]
    kubernetes_op_connect_app_name: Option<String>,
    #[arg(long, env = "KUBERNETES_OP_CONNECT_PORT")]
    kubernetes_op_connect_port: Option<u16>,
    #[arg(
        long,
        env = "KUBERNETES_API_POD_LABEL_SELECTOR",
        value_parser = parse_label_selector_arg
    )]
    kubernetes_api_pod_label_selector: Option<BTreeMap<String, String>>,
    #[arg(
        long,
        env = "KUBERNETES_TOKEN_BROKER_POD_LABEL_SELECTOR",
        value_parser = parse_label_selector_arg
    )]
    kubernetes_token_broker_pod_label_selector: Option<BTreeMap<String, String>>,
    #[arg(long, env = "KUBERNETES_TOKEN_BROKER_URL")]
    kubernetes_token_broker_url: Option<String>,
    #[arg(long, env = "KUBERNETES_TOKEN_BROKER_NAME")]
    kubernetes_token_broker_name: Option<String>,
    #[arg(long, env = "KUBERNETES_TOKEN_BROKER_CONFIGMAP_NAME")]
    kubernetes_token_broker_configmap_name: Option<String>,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum IronProxyMode {
    Auto,
    Enabled,
    Disabled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum IronProxySecretSourceArg {
    Env,
    #[value(name = "onepassword")]
    OnePassword,
    #[value(name = "onepassword-connect")]
    OnePasswordConnect,
}

fn default_sandbox_image(workload: SandboxWorkloadKind) -> &'static str {
    match workload {
        SandboxWorkloadKind::Mock => "busybox:1.36",
        SandboxWorkloadKind::CodexAppServer => "centaur-agent:latest",
    }
}

fn agent_sandbox_config_from_args(args: &Args) -> Result<AgentSandboxConfig, ServerError> {
    let mut config = AgentSandboxConfig::new(args.kubernetes_namespace.clone());
    config.image_pull_policy =
        clean_optional_value(args.kubernetes_agent_image_pull_policy.as_deref());
    config.image_pull_secrets = sandbox_image_pull_secrets_from_args(args);
    config.runtime_class_name =
        clean_optional_value(args.kubernetes_sandbox_runtime_class_name.as_deref());
    config.service_account_name =
        clean_optional_value(args.kubernetes_sandbox_service_account_name.as_deref());
    config.state_volume = sandbox_state_volume_from_args(args);
    config.iron_proxy = iron_proxy_config_from_args(args)?;
    Ok(config)
}

fn iron_proxy_config_from_args(args: &Args) -> Result<Option<IronProxyPodConfig>, ServerError> {
    let fragment_paths = iron_proxy_fragment_paths(args)?;
    let ca_cert_secret_name =
        clean_optional_value(args.kubernetes_firewall_ca_secret_name.as_deref());
    let ca_key_secret_name =
        clean_optional_value(args.kubernetes_firewall_ca_key_secret_name.as_deref());
    if !iron_proxy_enabled(
        args.kubernetes_sandbox_iron_proxy_mode,
        !fragment_paths.is_empty(),
        ca_cert_secret_name.is_some() && ca_key_secret_name.is_some(),
    ) {
        return Ok(None);
    }
    let image = clean_optional_value(args.kubernetes_iron_proxy_image.as_deref())
        .unwrap_or_else(|| "centaur-iron-proxy:latest".to_owned());
    let mut config = IronProxyPodConfig::new(
        image,
        ca_cert_secret_name.ok_or(ServerError::MissingIronProxyCaSecret)?,
        ca_key_secret_name.ok_or(ServerError::MissingIronProxyCaSecret)?,
    )
    .with_fragments(load_fragment_files(&fragment_paths)?);
    config.image_pull_policy =
        clean_optional_value(args.kubernetes_iron_proxy_image_pull_policy.as_deref())
            .or_else(|| clean_optional_value(args.kubernetes_agent_image_pull_policy.as_deref()));
    config.image_pull_secrets = sandbox_image_pull_secrets_from_args(args);
    config.source_policy = source_policy_from_args(args);
    if let Some(secret_name) = clean_optional_value(args.kubernetes_secret_env_name.as_deref()) {
        config.secret_env_name = Some(secret_name.clone());
        config.secret_env_prefix =
            clean_optional_value(args.kubernetes_secret_env_prefix.as_deref()).unwrap_or_default();
        config.env_from_secret_names.push(secret_name);
    }
    if matches!(config.source_policy.kind, SourceKind::OnePassword) {
        if let Some(secret_name) =
            clean_optional_value(args.kubernetes_bootstrap_secret_name.as_deref())
        {
            config.env_from_secret_names.push(secret_name);
        }
    }
    if let Some(app_name) = clean_optional_value(args.kubernetes_op_connect_app_name.as_deref()) {
        config.op_connect_app_name = app_name;
    }
    config.op_connect_port = args
        .kubernetes_op_connect_port
        .or_else(|| {
            clean_optional_value(args.kubernetes_op_connect_host.as_deref())
                .and_then(|value| parse_host_port(&value))
        })
        .unwrap_or(config.op_connect_port);
    if let Some(labels) = args
        .kubernetes_api_pod_label_selector
        .as_ref()
        .filter(|labels| !labels.is_empty())
    {
        config.api_pod_labels = labels.clone();
    }
    if let Some(labels) = args
        .kubernetes_token_broker_pod_label_selector
        .as_ref()
        .filter(|labels| !labels.is_empty())
    {
        config.token_broker_pod_labels = labels.clone();
    }
    config.harness_auth_modes = harness_auth_modes_from_args(args);
    insert_optional_env(
        &mut config.extra_env,
        "OP_CONNECT_HOST",
        clean_optional_value(args.kubernetes_op_connect_host.as_deref()),
    );
    insert_optional_env(
        &mut config.extra_env,
        "IRON_BROKER_URL",
        clean_optional_value(args.kubernetes_token_broker_url.as_deref()),
    );
    config.token_broker_name = clean_optional_value(args.kubernetes_token_broker_name.as_deref());
    config.token_broker_configmap_name =
        clean_optional_value(args.kubernetes_token_broker_configmap_name.as_deref());
    Ok(Some(config))
}

fn iron_proxy_fragment_paths(args: &Args) -> Result<Vec<PathBuf>, ServerError> {
    let mut paths = clean_paths(&args.kubernetes_iron_proxy_fragment_paths);
    let mut dirs = clean_paths(&args.kubernetes_iron_proxy_fragment_dirs);
    if dirs.is_empty() {
        dirs.extend(clean_paths(&args.tool_dirs));
    }
    paths.extend(discover_fragment_files(&dirs)?);
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn iron_proxy_enabled(
    mode: IronProxyMode,
    has_fragment_paths: bool,
    has_kubernetes_proxy_config: bool,
) -> bool {
    match mode {
        IronProxyMode::Auto => has_fragment_paths || has_kubernetes_proxy_config,
        IronProxyMode::Enabled => true,
        IronProxyMode::Disabled => false,
    }
}

fn source_policy_from_args(args: &Args) -> SourcePolicy {
    let op_vault =
        clean_optional_value(args.op_vault.as_deref()).unwrap_or_else(|| "ai-agents".to_owned());
    let ttl = clean_optional_value(Some(args.kubernetes_firewall_manager_secret_ttl.as_str()))
        .unwrap_or_else(|| "10m".to_owned());
    let token_broker_ttl = clean_optional_value(Some(
        args.kubernetes_firewall_manager_token_broker_ttl.as_str(),
    ))
    .unwrap_or_else(|| "1m".to_owned());

    match args.kubernetes_firewall_manager_secret_source {
        IronProxySecretSourceArg::Env => SourcePolicy::env(),
        IronProxySecretSourceArg::OnePassword => SourcePolicy::onepassword(op_vault, ttl),
        IronProxySecretSourceArg::OnePasswordConnect => {
            SourcePolicy::onepassword_connect(op_vault, ttl)
        }
    }
    .with_token_broker_ttl(token_broker_ttl)
}

fn harness_auth_modes_from_args(args: &Args) -> BTreeMap<String, String> {
    let mut modes = BTreeMap::new();
    if let Some(mode) = clean_optional_value(args.codex_auth_mode.as_deref()) {
        modes.insert("codex".to_owned(), mode);
    }
    if let Some(mode) = clean_optional_value(args.claude_code_auth_mode.as_deref()) {
        modes.insert("claude-code".to_owned(), mode);
    }
    modes
}

fn insert_optional_env(envs: &mut BTreeMap<String, String>, name: &str, value: Option<String>) {
    if let Some(value) = value {
        envs.insert(name.to_owned(), value);
    }
}

fn parse_host_port(value: &str) -> Option<u16> {
    value.rsplit_once(':')?.1.parse().ok()
}

fn parse_label_selector_arg(value: &str) -> Result<BTreeMap<String, String>, String> {
    let mut labels = BTreeMap::new();
    for item in value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        let Some((key, value)) = item.split_once('=') else {
            return Err(format!("label selector item {item:?} must be key=value"));
        };
        let key = key.trim();
        let value = value.trim();
        if key.is_empty() || value.is_empty() {
            return Err(format!("label selector item {item:?} must be key=value"));
        }
        labels.insert(key.to_owned(), value.to_owned());
    }
    Ok(labels)
}

fn sandbox_image_pull_secrets_from_args(args: &Args) -> Vec<String> {
    clean_values(&args.kubernetes_sandbox_image_pull_secrets)
}

fn sandbox_state_volume_from_args(args: &Args) -> Option<StateVolumeConfig> {
    if !args.kubernetes_sandbox_state_volume_enabled {
        return None;
    }
    let mount_path = clean_optional_value(args.kubernetes_sandbox_state_mount_path.as_deref())
        .unwrap_or_else(|| "/home/agent/state".to_owned());
    let size = clean_optional_value(args.kubernetes_sandbox_state_volume_size.as_deref())
        .unwrap_or_else(|| "10Gi".to_owned());
    let mut config = StateVolumeConfig::new(mount_path, size);
    if let Some(storage_class_name) = clean_optional_value(
        args.kubernetes_sandbox_state_volume_storage_class
            .as_deref(),
    ) {
        config = config.storage_class_name(storage_class_name);
    }
    Some(config)
}

fn tool_build_cache_mount_path(args: &Args) -> String {
    clean_optional_value(Some(args.kubernetes_tool_build_cache_mount_path.as_str()))
        .unwrap_or_else(|| DEFAULT_TOOL_BUILD_CACHE_MOUNT_PATH.to_owned())
}

fn clean_optional_value(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn clean_values(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn clean_paths(paths: &[PathBuf]) -> Vec<PathBuf> {
    paths
        .iter()
        .filter(|path| !path.as_os_str().is_empty())
        .cloned()
        .collect()
}

fn codex_app_server_env_template(args: &Args) -> Vec<(String, String)> {
    let mut envs = Vec::new();
    push_env(
        &mut envs,
        "CENTAUR_API_URL",
        clean_optional_value(Some(args.centaur_api_url.as_str()))
            .unwrap_or_else(|| "http://api:8000".to_owned()),
    );
    push_env(&mut envs, "CENTAUR_HARNESS_KIND", "codex".to_owned());
    if let Some(api_key) = clean_optional_value(args.centaur_api_key.as_deref()) {
        push_env(&mut envs, "CENTAUR_API_KEY", api_key.to_owned());
    }
    if let Some(value) = clean_optional_value(args.claude_code_auth_mode.as_deref()) {
        push_env(&mut envs, "CLAUDE_CODE_AUTH_MODE", value);
    }
    if let Some(value) = clean_optional_value(args.codex_auth_mode.as_deref()) {
        push_env(&mut envs, "CODEX_AUTH_MODE", value);
    }
    if let Some(overlay_repo) = overlay_repo_from_args(args) {
        push_env(&mut envs, "CENTAUR_OVERLAY_REPO", overlay_repo.clone());
        push_env(
            &mut envs,
            "CENTAUR_OVERLAY_DIR",
            format!("{SANDBOX_REPOS_MOUNT_PATH}/{overlay_repo}"),
        );
    }
    if clean_optional_value(args.kubernetes_tool_build_cache_host_path.as_deref()).is_some() {
        let mount_path = tool_build_cache_mount_path(args);
        push_env(&mut envs, "XDG_CACHE_HOME", mount_path.clone());
        push_env(&mut envs, "UV_CACHE_DIR", format!("{mount_path}/uv"));
        push_env(
            &mut envs,
            "UV_LINK_MODE",
            clean_optional_value(Some(args.kubernetes_tool_build_cache_uv_link_mode.as_str()))
                .unwrap_or_else(|| "copy".to_owned()),
        );
        push_env(&mut envs, "CARGO_HOME", format!("{mount_path}/cargo"));
        push_env(&mut envs, "GOCACHE", format!("{mount_path}/go-build"));
        push_env(&mut envs, "GOMODCACHE", format!("{mount_path}/go-mod"));
    }

    for name in clean_values(&args.kubernetes_sandbox_passthrough_env) {
        if let Ok(value) = env::var(&name) {
            push_env(&mut envs, &name, value);
        }
    }

    envs
}

fn overlay_repo_from_args(args: &Args) -> Option<String> {
    let repo = clean_optional_value(args.centaur_overlay_repo.as_deref())?
        .trim_matches('/')
        .to_owned();
    if repo.is_empty() || clean_optional_value(args.repos_path.as_deref()).is_none() {
        return None;
    }
    Some(repo)
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
    fn iron_proxy_enables_for_stock_kubernetes_proxy_config() {
        assert!(iron_proxy_enabled(IronProxyMode::Auto, false, true));
        assert!(iron_proxy_enabled(IronProxyMode::Auto, true, false));
        assert!(!iron_proxy_enabled(IronProxyMode::Auto, false, false));
    }

    #[test]
    fn iron_proxy_mode_overrides_auto_detection() {
        assert!(!iron_proxy_enabled(IronProxyMode::Disabled, true, true));
        assert!(iron_proxy_enabled(IronProxyMode::Enabled, false, false));
    }

    #[test]
    fn parses_label_selector_args_strictly() {
        let labels = parse_label_selector_arg("app=api, component = worker").unwrap();

        assert_eq!(labels["app"], "api");
        assert_eq!(labels["component"], "worker");
        assert!(parse_label_selector_arg("app").is_err());
        assert!(parse_label_selector_arg("app=").is_err());
    }

    #[test]
    fn clap_drives_iron_proxy_config() {
        let args = Args::try_parse_from([
            "centaur-api-server",
            "--database-url",
            "postgresql://postgres@localhost/centaur",
            "--kubernetes-sandbox-iron-proxy-mode",
            "enabled",
            "--kubernetes-iron-proxy-image",
            "centaur-iron-proxy:test",
            "--kubernetes-firewall-ca-secret-name",
            "firewall-ca-cert",
            "--kubernetes-firewall-ca-key-secret-name",
            "firewall-ca-key",
            "--kubernetes-firewall-manager-secret-source",
            "onepassword-connect",
            "--op-vault",
            "engineering",
            "--kubernetes-firewall-manager-secret-ttl",
            "5m",
            "--kubernetes-firewall-manager-token-broker-ttl",
            "30s",
            "--codex-auth-mode",
            "access_token",
        ])
        .unwrap();

        let config = iron_proxy_config_from_args(&args).unwrap().unwrap();

        assert_eq!(config.image, "centaur-iron-proxy:test");
        assert_eq!(config.ca_cert_secret_name, "firewall-ca-cert");
        assert_eq!(config.ca_key_secret_name, "firewall-ca-key");
        assert!(matches!(
            config.source_policy.kind,
            SourceKind::OnePasswordConnect
        ));
        assert_eq!(config.source_policy.op_vault, "engineering");
        assert_eq!(config.source_policy.ttl, "5m");
        assert_eq!(config.source_policy.token_broker_ttl, "30s");
        assert_eq!(config.harness_auth_modes["codex"], "access_token");
    }

    #[test]
    fn codex_workload_mounts_tool_build_cache() {
        let args = Args::try_parse_from([
            "centaur-api-server",
            "--database-url",
            "postgresql://postgres@localhost/centaur",
            "--kubernetes-sandbox-workload",
            "codex-app-server",
            "--kubernetes-tool-build-cache-host-path",
            "/var/lib/centaur/tool-build-cache",
            "--kubernetes-tool-build-cache-mount-path",
            "/home/agent/.cache",
        ])
        .unwrap();

        let workload = container_workload_mode(&args).unwrap();
        let SandboxWorkloadMode::CodexAppServer { env, mounts, .. } = workload else {
            panic!("expected codex app server workload");
        };

        assert!(mounts.iter().any(|mount| {
            mount.target_path == "/home/agent/.cache"
                && !mount.read_only
                && mount.kind
                    == (MountKind::Bind {
                        source_path: "/var/lib/centaur/tool-build-cache".to_owned(),
                    })
        }));

        let env = env.into_iter().collect::<BTreeMap<_, _>>();
        assert_eq!(env["CENTAUR_HARNESS_KIND"], "codex");
        assert_eq!(env["XDG_CACHE_HOME"], "/home/agent/.cache");
        assert_eq!(env["UV_CACHE_DIR"], "/home/agent/.cache/uv");
        assert_eq!(env["UV_LINK_MODE"], "copy");
        assert_eq!(env["CARGO_HOME"], "/home/agent/.cache/cargo");
        assert_eq!(env["GOCACHE"], "/home/agent/.cache/go-build");
        assert_eq!(env["GOMODCACHE"], "/home/agent/.cache/go-mod");
    }

    #[test]
    fn codex_workload_exposes_repo_cache_overlay_to_sandbox() {
        let args = Args::try_parse_from([
            "centaur-api-server",
            "--database-url",
            "postgresql://postgres@localhost/centaur",
            "--kubernetes-sandbox-workload",
            "codex-app-server",
            "--repos-path",
            "/var/lib/centaur/repos",
            "--centaur-overlay-repo",
            "paradigmxyz/centaur-acme",
        ])
        .unwrap();

        let workload = container_workload_mode(&args).unwrap();
        let SandboxWorkloadMode::CodexAppServer { env, mounts, .. } = workload else {
            panic!("expected codex app server workload");
        };

        assert!(mounts.iter().any(|mount| {
            mount.target_path == SANDBOX_REPOS_MOUNT_PATH
                && mount.read_only
                && mount.kind
                    == (MountKind::Bind {
                        source_path: "/var/lib/centaur/repos".to_owned(),
                    })
        }));

        let env = env.into_iter().collect::<BTreeMap<_, _>>();
        assert_eq!(env["CENTAUR_OVERLAY_REPO"], "paradigmxyz/centaur-acme");
        assert_eq!(
            env["CENTAUR_OVERLAY_DIR"],
            "/home/agent/github/paradigmxyz/centaur-acme"
        );
    }
}

#[derive(Debug, Error)]
enum ServerError {
    #[error(
        "KUBERNETES_FIREWALL_CA_SECRET_NAME and KUBERNETES_FIREWALL_CA_KEY_SECRET_NAME are required when sandbox iron-proxy is enabled"
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
