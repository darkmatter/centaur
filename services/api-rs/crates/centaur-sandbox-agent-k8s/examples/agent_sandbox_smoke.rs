use std::collections::BTreeMap;
use std::env;
use std::time::Duration;

use centaur_sandbox_agent_k8s::{AgentSandboxBackend, AgentSandboxConfig, IronProxyPodConfig};
use centaur_sandbox_core::{SandboxBackend, SandboxSpec, SandboxStatus};
use clap::Parser;
use kube::config::KubeConfigOptions;
use kube::{Client, Config};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    let kube_config = Config::from_kubeconfig(&KubeConfigOptions {
        context: Some(args.kube_context),
        ..KubeConfigOptions::default()
    })
    .await?;
    let client = Client::try_from(kube_config)?;

    let mut labels = BTreeMap::new();
    labels.insert("centaur.ai/smoke".to_owned(), "agent-sandbox".to_owned());
    let mut config = AgentSandboxConfig::new(args.kube_namespace);
    config.labels = labels;
    config.ready_timeout = Duration::from_secs(90);
    if let Some(iron_proxy) = iron_proxy_config_from_env()? {
        config.iron_proxy = Some(iron_proxy);
    }

    let backend = AgentSandboxBackend::new(client, config);
    let spec = SandboxSpec::new(args.sandbox_image)
        .command(["/bin/sh", "-lc"])
        .args(["sleep 3600"]);

    let handle = backend.create(spec).await?;
    println!("created {}", handle.id.as_str());

    let status = backend.status(&handle.id).await?;
    println!("status after create: {status:?}");
    assert_eq!(status, SandboxStatus::Running);

    backend.pause(&handle.id).await?;
    let status = backend.status(&handle.id).await?;
    println!("status after pause: {status:?}");
    assert!(matches!(
        status,
        SandboxStatus::Suspended | SandboxStatus::Created | SandboxStatus::Running
    ));

    backend.resume(&handle.id).await?;
    let status = backend.status(&handle.id).await?;
    println!("status after resume: {status:?}");
    assert_eq!(status, SandboxStatus::Running);

    backend.stop(&handle.id).await?;
    println!("stopped {}", handle.id.as_str());

    Ok(())
}

#[derive(Debug, Parser)]
#[command(about = "Smoke test the Kubernetes AgentSandbox backend")]
struct Args {
    #[arg(long, env = "KUBE_CONTEXT", default_value = "orbstack")]
    kube_context: String,
    #[arg(long, env = "KUBE_NAMESPACE", default_value = "centaur")]
    kube_namespace: String,
    #[arg(long, env = "SANDBOX_IMAGE", default_value = "busybox:1.36")]
    sandbox_image: String,
}

fn iron_proxy_config_from_env() -> Result<Option<IronProxyPodConfig>, Box<dyn std::error::Error>> {
    let Ok(image) = env::var("IRON_PROXY_IMAGE") else {
        return Ok(None);
    };
    let ca_cert_secret_name = env::var("IRON_PROXY_CA_CERT_SECRET")?;
    let ca_key_secret_name = env::var("IRON_PROXY_CA_KEY_SECRET")?;
    let mut config = IronProxyPodConfig::new(image, ca_cert_secret_name, ca_key_secret_name);
    config.image_pull_policy = env::var("IRON_PROXY_IMAGE_PULL_POLICY").ok();
    if let Ok(secret_name) = env::var("IRON_PROXY_ENV_SECRET") {
        config.secret_env_name = Some(secret_name.clone());
        config.env_from_secret_names.push(secret_name);
        config.secret_env_prefix = env::var("IRON_PROXY_ENV_SECRET_PREFIX").unwrap_or_default();
    }
    Ok(Some(config))
}
