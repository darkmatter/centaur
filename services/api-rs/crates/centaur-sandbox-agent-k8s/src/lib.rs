//! Agent Sandbox Kubernetes backend.
//!
//! The Agent Sandbox CRD types are generated from the upstream CRD with
//! `just codegen-agent-sandbox-crd`.

use std::collections::BTreeMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use centaur_iron_proxy::{ProxyFragment, SourceKind};
use centaur_sandbox_core::{
    MountKind, ObservedSandbox, SandboxBackend, SandboxError, SandboxHandle, SandboxId, SandboxIo,
    SandboxResult, SandboxSpec, SandboxStatus,
};
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{
    Capabilities, ConfigMap, ConfigMapVolumeSource, Container, ContainerPort, EmptyDirVolumeSource,
    EnvFromSource, EnvVar, EnvVarSource, HTTPGetAction, HostPathVolumeSource, LocalObjectReference,
    PersistentVolumeClaimVolumeSource, Pod, PodSpec, Probe, ResourceRequirements, SeccompProfile,
    SecretEnvSource, SecretKeySelector, SecretVolumeSource, SecurityContext, Service, ServicePort,
    ServiceSpec, Volume, VolumeMount,
};
use k8s_openapi::api::networking::v1::{
    NetworkPolicy, NetworkPolicyEgressRule, NetworkPolicyIngressRule, NetworkPolicyPeer,
    NetworkPolicyPort, NetworkPolicySpec,
};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, ObjectMeta};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::api::{AttachParams, DeleteParams, ListParams, Patch, PatchParams, PostParams};
use kube::{Api, Client, Error};
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::{Instant, sleep};
use uuid::Uuid;

pub use generated::agents_x_k8s_io as crd;

mod config;
pub mod generated;

pub use config::{AgentSandboxConfig, IronProxyPodConfig};

const BACKEND_NAME: &str = "agent-sandbox-k8s";
const MANAGED_LABEL: &str = "centaur.ai/managed";
const MANAGED_BY_LABEL: &str = "centaur.ai/managed-by";
const SANDBOX_ID_LABEL: &str = "centaur.ai/sandbox-id";
const MANAGED_BY_VALUE: &str = "api-rs";
const TOKEN_BROKER_LABEL: &str = "centaur.ai/iron-token-broker";
const TOKEN_BROKER_CONFIG_KEY: &str = "iron-token-broker.yaml";

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Eq, PartialEq)]
struct ResolvedIronProxy {
    config_yaml: String,
    placeholder_env: BTreeMap<String, String>,
    proxy_host: String,
    proxy_pod_name: String,
    proxy_port: u16,
    listen_ports: Vec<u16>,
    pg_dsn_env: BTreeMap<String, String>,
    pg_proxy_password_env: BTreeMap<String, String>,
}

#[derive(Clone)]
pub struct AgentSandboxBackend {
    client: Client,
    config: AgentSandboxConfig,
}

impl AgentSandboxBackend {
    pub fn new(client: Client, config: AgentSandboxConfig) -> Self {
        Self { client, config }
    }

    pub async fn try_default(namespace: impl Into<String>) -> SandboxResult<Self> {
        let client = Client::try_default()
            .await
            .map_err(|err| SandboxError::Backend(format!("create kube client: {err}")))?;
        Ok(Self::new(client, AgentSandboxConfig::new(namespace)))
    }

    fn sandboxes(&self) -> Api<crd::Sandbox> {
        Api::namespaced(self.client.clone(), &self.config.namespace)
    }

    fn pods(&self) -> Api<Pod> {
        Api::namespaced(self.client.clone(), &self.config.namespace)
    }

    fn config_maps(&self) -> Api<ConfigMap> {
        Api::namespaced(self.client.clone(), &self.config.namespace)
    }

    fn services(&self) -> Api<Service> {
        Api::namespaced(self.client.clone(), &self.config.namespace)
    }

    fn network_policies(&self) -> Api<NetworkPolicy> {
        Api::namespaced(self.client.clone(), &self.config.namespace)
    }

    fn deployments(&self) -> Api<Deployment> {
        Api::namespaced(self.client.clone(), &self.config.namespace)
    }

    async fn get_sandbox(&self, id: &SandboxId) -> SandboxResult<Option<crd::Sandbox>> {
        match self.sandboxes().get(id.as_str()).await {
            Ok(sandbox) => Ok(Some(sandbox)),
            Err(err) if is_not_found(&err) => Ok(None),
            Err(err) => Err(map_kube_error("get sandbox", err)),
        }
    }

    async fn get_pod(&self, id: &SandboxId) -> SandboxResult<Option<Pod>> {
        match self.pods().get(id.as_str()).await {
            Ok(pod) => Ok(Some(pod)),
            Err(err) if is_not_found(&err) => Ok(None),
            Err(err) => Err(map_kube_error("get sandbox pod", err)),
        }
    }

    async fn patch_replicas(&self, id: &SandboxId, replicas: i32) -> SandboxResult<()> {
        let params = PatchParams::apply(&self.config.field_manager);
        let patch = Patch::Merge(json!({ "spec": { "replicas": replicas } }));
        self.sandboxes()
            .patch(id.as_str(), &params, &patch)
            .await
            .map(|_| ())
            .map_err(|err| map_kube_error("patch sandbox replicas", err))
    }

    fn resolve_iron_proxy(
        &self,
        id: &SandboxId,
        spec: &SandboxSpec,
    ) -> SandboxResult<Option<ResolvedIronProxy>> {
        let Some(iron_proxy) = &self.config.iron_proxy else {
            return Ok(None);
        };
        let fragments = iron_proxy_fragments_for_spec(iron_proxy, spec)?;
        let config_yaml = centaur_iron_proxy::render_proxy_yaml_with_source_policy(
            None,
            &fragments,
            &iron_proxy.source_policy,
        )
        .map_err(|err| SandboxError::InvalidSpec(format!("iron-proxy config: {err}")))?;
        let placeholder_env = centaur_iron_proxy::placeholder_env(&fragments);
        let proxy_port = centaur_iron_proxy::proxy_listen_port_from_yaml(&config_yaml)
            .map_err(|err| SandboxError::InvalidSpec(format!("iron-proxy proxy port: {err}")))?;
        let listen_ports = centaur_iron_proxy::listen_ports_from_yaml(&config_yaml)
            .map_err(|err| SandboxError::InvalidSpec(format!("iron-proxy listen ports: {err}")))?;
        let proxy_host = iron_proxy_service_name(id);
        let mut pg_dsn_env = BTreeMap::new();
        let mut pg_proxy_password_env = BTreeMap::new();
        for entry in centaur_iron_proxy::pg_dsn_envs(&fragments) {
            let password = pg_proxy_password_env
                .entry(entry.password_env.clone())
                .or_insert_with(proxy_password)
                .clone();
            pg_dsn_env.entry(entry.env_name).or_insert_with(|| {
                proxied_pg_url(&proxy_host, entry.port, &password, &entry.database)
            });
        }
        Ok(Some(ResolvedIronProxy {
            config_yaml,
            placeholder_env,
            proxy_host,
            proxy_pod_name: new_iron_proxy_pod_name(id),
            proxy_port,
            listen_ports,
            pg_dsn_env,
            pg_proxy_password_env,
        }))
    }

    async fn create_iron_proxy_configmap(
        &self,
        id: &SandboxId,
        resolved: Option<&ResolvedIronProxy>,
    ) -> SandboxResult<()> {
        let Some(resolved) = resolved else {
            return Ok(());
        };
        let name = iron_proxy_configmap_name(id);
        let _ = self.delete_iron_proxy_configmap(id).await;
        let body = ConfigMap {
            metadata: object_meta(name, iron_proxy_labels(id)),
            data: Some(BTreeMap::from([(
                "proxy.yaml".to_owned(),
                resolved.config_yaml.clone(),
            )])),
            ..Default::default()
        };
        self.config_maps()
            .create(&PostParams::default(), &body)
            .await
            .map(|_| ())
            .map_err(|err| map_kube_error("create iron-proxy configmap", err))
    }

    async fn delete_iron_proxy_configmap(&self, id: &SandboxId) -> SandboxResult<()> {
        if self.config.iron_proxy.is_none() {
            return Ok(());
        }
        match self
            .config_maps()
            .delete(&iron_proxy_configmap_name(id), &DeleteParams::default())
            .await
        {
            Ok(_) => Ok(()),
            Err(err) if is_not_found(&err) => Ok(()),
            Err(err) => Err(map_kube_error("delete iron-proxy configmap", err)),
        }
    }

    async fn reconcile_token_broker(&self, iron_proxy: &IronProxyPodConfig) -> SandboxResult<()> {
        let Some(token_broker_name) = iron_proxy.token_broker_name.as_deref() else {
            return Ok(());
        };
        let mut fragments = centaur_iron_proxy::harness_broker_fragments().map_err(|err| {
            SandboxError::InvalidSpec(format!("iron-token-broker fragments: {err}"))
        })?;
        fragments.extend(iron_proxy.fragments.clone());
        let rendered = centaur_iron_proxy::render_token_broker_yaml_with_source_policy(
            &fragments,
            &iron_proxy.source_policy,
        )
        .map_err(|err| SandboxError::InvalidSpec(format!("iron-token-broker config: {err}")))?;
        if self
            .apply_token_broker_configmap(iron_proxy, &rendered)
            .await?
        {
            self.patch_token_broker_config_hash(token_broker_name, &short_sha256(&rendered))
                .await?;
        }
        Ok(())
    }

    async fn apply_token_broker_configmap(
        &self,
        iron_proxy: &IronProxyPodConfig,
        rendered: &str,
    ) -> SandboxResult<bool> {
        let name = iron_token_broker_configmap_name(iron_proxy)?;
        let data = BTreeMap::from([(TOKEN_BROKER_CONFIG_KEY.to_owned(), rendered.to_owned())]);
        match self.config_maps().get(&name).await {
            Ok(existing) => {
                if existing
                    .data
                    .as_ref()
                    .and_then(|data| data.get(TOKEN_BROKER_CONFIG_KEY))
                    .is_some_and(|value| value == rendered)
                {
                    return Ok(false);
                }
                let patch = Patch::Merge(json!({
                    "metadata": {"labels": token_broker_labels()},
                    "data": data,
                }));
                self.config_maps()
                    .patch(&name, &PatchParams::default(), &patch)
                    .await
                    .map(|_| true)
                    .map_err(|err| map_kube_error("patch iron-token-broker configmap", err))
            }
            Err(err) if is_not_found(&err) => {
                let body = ConfigMap {
                    metadata: object_meta(name, token_broker_labels()),
                    data: Some(data),
                    ..Default::default()
                };
                self.config_maps()
                    .create(&PostParams::default(), &body)
                    .await
                    .map(|_| true)
                    .map_err(|err| map_kube_error("create iron-token-broker configmap", err))
            }
            Err(err) => Err(map_kube_error("get iron-token-broker configmap", err)),
        }
    }

    async fn patch_token_broker_config_hash(
        &self,
        token_broker_name: &str,
        config_hash: &str,
    ) -> SandboxResult<()> {
        let patch = Patch::Merge(json!({
            "spec": {
                "template": {
                    "metadata": {
                        "annotations": {
                            "centaur.ai/config-hash": config_hash,
                        },
                    },
                },
            },
        }));
        match self
            .deployments()
            .patch(token_broker_name, &PatchParams::default(), &patch)
            .await
        {
            Ok(_) => Ok(()),
            Err(err) if is_not_found(&err) => Ok(()),
            Err(err) => Err(map_kube_error("patch iron-token-broker deployment", err)),
        }
    }

    async fn create_iron_proxy_resources(
        &self,
        id: &SandboxId,
        resolved: Option<&ResolvedIronProxy>,
    ) -> SandboxResult<()> {
        let Some(resolved) = resolved else {
            return Ok(());
        };
        if let Some(iron_proxy) = &self.config.iron_proxy {
            self.reconcile_token_broker(iron_proxy).await?;
        }
        self.delete_iron_proxy_resources(id).await?;
        self.create_iron_proxy_configmap(id, Some(resolved)).await?;
        self.create_iron_proxy_service(id, resolved).await?;
        self.create_iron_proxy_network_policies(id, resolved)
            .await?;
        self.create_iron_proxy_pod(id, resolved).await?;
        self.wait_until_proxy_running(resolved).await
    }

    async fn create_iron_proxy_service(
        &self,
        id: &SandboxId,
        resolved: &ResolvedIronProxy,
    ) -> SandboxResult<()> {
        let service = build_iron_proxy_service(id, resolved);
        self.services()
            .create(&PostParams::default(), &service)
            .await
            .map(|_| ())
            .map_err(|err| map_kube_error("create iron-proxy service", err))
    }

    async fn create_iron_proxy_pod(
        &self,
        id: &SandboxId,
        resolved: &ResolvedIronProxy,
    ) -> SandboxResult<()> {
        let Some(iron_proxy) = &self.config.iron_proxy else {
            return Ok(());
        };
        let pod = build_iron_proxy_pod(id, &resolved.proxy_pod_name, iron_proxy, resolved);
        self.pods()
            .create(&PostParams::default(), &pod)
            .await
            .map(|_| ())
            .map_err(|err| map_kube_error("create iron-proxy pod", err))
    }

    async fn create_iron_proxy_network_policies(
        &self,
        id: &SandboxId,
        resolved: &ResolvedIronProxy,
    ) -> SandboxResult<()> {
        let Some(iron_proxy) = &self.config.iron_proxy else {
            return Ok(());
        };
        for policy in build_iron_proxy_network_policies(id, resolved, iron_proxy) {
            self.network_policies()
                .create(&PostParams::default(), &policy)
                .await
                .map_err(|err| map_kube_error("create iron-proxy network policy", err))?;
        }
        Ok(())
    }

    async fn delete_iron_proxy_resources(&self, id: &SandboxId) -> SandboxResult<()> {
        if self.config.iron_proxy.is_none() {
            return Ok(());
        }
        let _ = self
            .pods()
            .delete(&iron_proxy_pod_name(id), &DeleteParams::default())
            .await;
        let _ = self.delete_iron_proxy_pods_for_sandbox(id).await;
        let _ = self
            .services()
            .delete(&iron_proxy_service_name(id), &DeleteParams::default())
            .await;
        for name in [
            iron_proxy_sandbox_egress_policy_name(id),
            iron_proxy_policy_name(id),
        ] {
            let _ = self
                .network_policies()
                .delete(&name, &DeleteParams::default())
                .await;
        }
        self.delete_iron_proxy_configmap(id).await
    }

    async fn delete_iron_proxy_pods_for_sandbox(&self, id: &SandboxId) -> SandboxResult<()> {
        let params = ListParams::default().labels(&format!(
            "centaur.ai/iron-proxy=true,{SANDBOX_ID_LABEL}={}",
            id.as_str()
        ));
        let pods = self
            .pods()
            .list(&params)
            .await
            .map_err(|err| map_kube_error("list iron-proxy pods", err))?;
        for pod in pods.items {
            if let Some(name) = pod.metadata.name {
                let _ = self.pods().delete(&name, &DeleteParams::default()).await;
            }
        }
        Ok(())
    }

    async fn wait_until_running(&self, id: &SandboxId) -> SandboxResult<()> {
        let deadline = Instant::now() + self.config.ready_timeout;
        loop {
            match self.status(id).await? {
                SandboxStatus::Running => return Ok(()),
                SandboxStatus::Gone | SandboxStatus::Stopped => {
                    return Err(SandboxError::NotReady(format!(
                        "sandbox {} reached terminal state before running",
                        id.as_str()
                    )));
                }
                status if Instant::now() >= deadline => {
                    return Err(SandboxError::NotReady(format!(
                        "sandbox {} did not become running before timeout; latest status: {status:?}",
                        id.as_str()
                    )));
                }
                _ => sleep(Duration::from_millis(500)).await,
            }
        }
    }

    async fn wait_until_proxy_running(&self, resolved: &ResolvedIronProxy) -> SandboxResult<()> {
        let deadline = Instant::now() + self.config.ready_timeout;
        let pod_name = &resolved.proxy_pod_name;
        loop {
            match self.pods().get(pod_name).await {
                Ok(pod) if sandbox_status_from_pod(1, Some(&pod)) == SandboxStatus::Running => {
                    return Ok(());
                }
                Ok(pod) if sandbox_status_from_pod(1, Some(&pod)) == SandboxStatus::Stopped => {
                    return Err(SandboxError::NotReady(format!(
                        "iron-proxy pod {pod_name} reached terminal state before running"
                    )));
                }
                Ok(pod) if Instant::now() >= deadline => {
                    return Err(SandboxError::NotReady(format!(
                        "iron-proxy pod {pod_name} did not become running before timeout; latest phase: {:?}",
                        pod.status.and_then(|status| status.phase)
                    )));
                }
                Ok(_) => sleep(Duration::from_millis(500)).await,
                Err(err) if is_not_found(&err) && Instant::now() < deadline => {
                    sleep(Duration::from_millis(500)).await;
                }
                Err(err) if is_not_found(&err) => {
                    return Err(SandboxError::NotReady(format!(
                        "iron-proxy pod {pod_name} was not created before timeout"
                    )));
                }
                Err(err) => return Err(map_kube_error("wait iron-proxy pod", err)),
            }
        }
    }

    async fn attach_io(&self, id: &SandboxId) -> SandboxResult<SandboxIo> {
        if self.status(id).await? != SandboxStatus::Running {
            return Err(SandboxError::NotReady(format!(
                "agent sandbox {} is not running",
                id.as_str()
            )));
        }
        let params = AttachParams::default()
            .container(self.config.container_name.clone())
            .stdin(true)
            .stdout(true)
            .stderr(true)
            .tty(false)
            .max_stdout_buf_size(1024 * 1024)
            .max_stderr_buf_size(1024 * 1024);
        let mut attached = self
            .pods()
            .attach(id.as_str(), &params)
            .await
            .map_err(|err| map_kube_error("attach sandbox pod", err))?;
        let stdin = attached
            .stdin()
            .map(|stream| Box::pin(stream) as Pin<Box<dyn AsyncWrite + Send>>);
        let stdout = attached
            .stdout()
            .map(|stream| Box::pin(stream) as Pin<Box<dyn AsyncRead + Send>>);
        let stderr = attached
            .stderr()
            .map(|stream| Box::pin(stream) as Pin<Box<dyn AsyncRead + Send>>);
        let stdin = stdin.ok_or_else(|| SandboxError::Io("stdin was not attached".to_owned()))?;
        let stdout =
            stdout.ok_or_else(|| SandboxError::Io("stdout was not attached".to_owned()))?;
        let stderr =
            stderr.ok_or_else(|| SandboxError::Io("stderr was not attached".to_owned()))?;
        // Keep kube's attach process alive as long as the returned streams are in use.
        Ok(SandboxIo::with_guard(stdin, stdout, stderr, attached))
    }
}

#[async_trait]
impl SandboxBackend for AgentSandboxBackend {
    fn name(&self) -> &'static str {
        BACKEND_NAME
    }

    async fn create(&self, spec: SandboxSpec) -> SandboxResult<SandboxHandle> {
        let id = SandboxId::new(next_sandbox_name());
        let resolved_iron_proxy = self.resolve_iron_proxy(&id, &spec)?;
        if let Err(err) = self
            .create_iron_proxy_resources(&id, resolved_iron_proxy.as_ref())
            .await
        {
            let _ = self.delete_iron_proxy_resources(&id).await;
            return Err(err);
        }
        let sandbox = build_agent_sandbox(&id, &spec, &self.config, resolved_iron_proxy.as_ref())?;
        let create_result = self
            .sandboxes()
            .create(&PostParams::default(), &sandbox)
            .await
            .map_err(|err| map_kube_error("create sandbox", err));
        if let Err(err) = create_result {
            let _ = self.delete_iron_proxy_resources(&id).await;
            return Err(err);
        }
        if let Err(err) = self.wait_until_running(&id).await {
            let _ = self.stop(&id).await;
            return Err(err);
        }
        Ok(SandboxHandle::new(id, BACKEND_NAME))
    }

    async fn open_io(&self, id: &SandboxId) -> SandboxResult<SandboxIo> {
        self.attach_io(id).await
    }

    async fn status(&self, id: &SandboxId) -> SandboxResult<SandboxStatus> {
        let Some(sandbox) = self.get_sandbox(id).await? else {
            return Ok(SandboxStatus::Gone);
        };
        let replicas = sandbox.spec.replicas.unwrap_or(1);
        let pod = self.get_pod(id).await?;
        Ok(sandbox_status_from_pod(replicas, pod.as_ref()))
    }

    async fn observe(&self, id: &SandboxId) -> SandboxResult<ObservedSandbox> {
        let status = self.status(id).await?;
        Ok(ObservedSandbox::new(id.clone(), BACKEND_NAME, status))
    }

    async fn list_observed(&self) -> SandboxResult<Vec<ObservedSandbox>> {
        let params =
            ListParams::default().labels(&format!("{MANAGED_BY_LABEL}={MANAGED_BY_VALUE}"));
        let sandboxes = self
            .sandboxes()
            .list(&params)
            .await
            .map_err(|err| map_kube_error("list sandboxes", err))?;
        let mut observed = Vec::with_capacity(sandboxes.items.len());
        for sandbox in sandboxes.items {
            let Some(name) = sandbox.metadata.name else {
                continue;
            };
            let id = SandboxId::new(name);
            observed.push(self.observe(&id).await?);
        }
        Ok(observed)
    }

    async fn stop(&self, id: &SandboxId) -> SandboxResult<()> {
        match self
            .sandboxes()
            .delete(id.as_str(), &DeleteParams::default())
            .await
        {
            Ok(_) => Ok(()),
            Err(err) if is_not_found(&err) => Ok(()),
            Err(err) => Err(map_kube_error("delete sandbox", err)),
        }?;
        self.delete_iron_proxy_resources(id).await
    }

    async fn pause(&self, id: &SandboxId) -> SandboxResult<()> {
        self.patch_replicas(id, 0).await
    }

    async fn resume(&self, id: &SandboxId) -> SandboxResult<()> {
        self.patch_replicas(id, 1).await?;
        self.wait_until_running(id).await
    }
}

fn sandbox_status_from_pod(replicas: i32, pod: Option<&Pod>) -> SandboxStatus {
    if replicas == 0 {
        return SandboxStatus::Suspended;
    }
    // The backing Pod Ready condition is the attach boundary; phase alone can be Running while
    // the sandbox is still not ready for I/O.
    let Some(pod) = pod else {
        return SandboxStatus::Created;
    };
    if pod.metadata.deletion_timestamp.is_some() {
        return SandboxStatus::Created;
    }

    let phase = pod
        .status
        .as_ref()
        .and_then(|status| status.phase.as_deref())
        .unwrap_or("unknown")
        .to_ascii_lowercase();
    match phase.as_str() {
        "running" if pod_ready(pod) => SandboxStatus::Running,
        "running" | "pending" => SandboxStatus::Created,
        "succeeded" | "failed" => SandboxStatus::Stopped,
        "unknown" => SandboxStatus::Unknown("unknown".to_owned()),
        other => SandboxStatus::Unknown(other.to_owned()),
    }
}

fn pod_ready(pod: &Pod) -> bool {
    pod.status
        .as_ref()
        .and_then(|status| status.conditions.as_ref())
        .is_some_and(|conditions| {
            conditions
                .iter()
                .any(|condition| condition.type_ == "Ready" && condition.status == "True")
        })
}

fn build_agent_sandbox(
    id: &SandboxId,
    spec: &SandboxSpec,
    config: &AgentSandboxConfig,
    resolved_iron_proxy: Option<&ResolvedIronProxy>,
) -> SandboxResult<crd::Sandbox> {
    let mut labels = config.labels.clone();
    labels.insert(MANAGED_LABEL.to_owned(), "true".to_owned());
    labels.insert(MANAGED_BY_LABEL.to_owned(), MANAGED_BY_VALUE.to_owned());
    labels.insert(SANDBOX_ID_LABEL.to_owned(), id.as_str().to_owned());

    let mut pod_labels = labels.clone();
    pod_labels.insert(
        "app.kubernetes.io/name".to_owned(),
        "centaur-sandbox".to_owned(),
    );

    let (mut volumes, mut volume_mounts) = mounts(spec);
    if let Some(iron_proxy) = &config.iron_proxy {
        volume_mounts.push(volume_mount("iron-proxy-ca-cert", "/firewall-certs", true));
        volumes.push(secret_volume(
            "iron-proxy-ca-cert",
            iron_proxy.ca_cert_secret_name.clone(),
        ));
    }

    let container = Container {
        name: config.container_name.clone(),
        image: Some(spec.image.clone()),
        image_pull_policy: config.image_pull_policy.clone(),
        command: spec.command.clone(),
        args: (!spec.args.is_empty()).then(|| spec.args.clone()),
        env: env_vars(spec, resolved_iron_proxy),
        working_dir: spec.working_dir.clone(),
        resources: resources(spec),
        stdin: Some(true),
        stdin_once: Some(false),
        tty: Some(false),
        volume_mounts: (!volume_mounts.is_empty()).then_some(volume_mounts),
        ..Default::default()
    };

    let crd_spec = agent_sandbox_spec_from(AgentSandboxSpec {
        replicas: Some(1),
        service: Some(false),
        shutdown_policy: Some(crd::SandboxShutdownPolicy::Retain),
        pod_template: AgentPodTemplate {
            metadata: AgentPodTemplateMetadata {
                labels: Some(pod_labels),
                annotations: Some(config.annotations.clone()),
            },
            spec: PodSpec {
                containers: vec![container],
                restart_policy: Some("Never".to_owned()),
                automount_service_account_token: Some(false),
                image_pull_secrets: image_pull_secret_refs(&config.image_pull_secrets),
                runtime_class_name: config.runtime_class_name.clone(),
                service_account_name: config.service_account_name.clone(),
                volumes: (!volumes.is_empty()).then_some(volumes),
                ..Default::default()
            },
        },
    })?;
    let mut sandbox = crd::Sandbox::new(id.as_str(), crd_spec);
    sandbox.metadata.labels = Some(labels);
    sandbox.metadata.annotations = Some(config.annotations.clone());
    Ok(sandbox)
}

#[derive(Serialize)]
struct AgentSandboxSpec {
    #[serde(rename = "podTemplate")]
    pod_template: AgentPodTemplate,
    replicas: Option<i32>,
    service: Option<bool>,
    #[serde(rename = "shutdownPolicy")]
    shutdown_policy: Option<crd::SandboxShutdownPolicy>,
}

#[derive(Serialize)]
struct AgentPodTemplate {
    metadata: AgentPodTemplateMetadata,
    spec: PodSpec,
}

#[derive(Serialize)]
struct AgentPodTemplateMetadata {
    labels: Option<BTreeMap<String, String>>,
    annotations: Option<BTreeMap<String, String>>,
}

fn agent_sandbox_spec_from(spec: AgentSandboxSpec) -> SandboxResult<crd::SandboxSpec> {
    serde_json::to_value(spec)
        .and_then(serde_json::from_value)
        .map_err(|err| SandboxError::InvalidSpec(format!("invalid Agent Sandbox spec: {err}")))
}

fn mounts(spec: &SandboxSpec) -> (Vec<Volume>, Vec<VolumeMount>) {
    let mut volumes = Vec::with_capacity(spec.mounts.len());
    let mut mounts = Vec::with_capacity(spec.mounts.len());
    for (index, mount) in spec.mounts.iter().enumerate() {
        let name = format!("mount-{index}");
        mounts.push(VolumeMount {
            name: name.clone(),
            mount_path: mount.target_path.clone(),
            read_only: Some(mount.read_only),
            ..Default::default()
        });
        volumes.push(match &mount.kind {
            MountKind::EmptyDir => empty_dir_volume(&name),
            MountKind::NamedVolume(claim_name) => Volume {
                name,
                persistent_volume_claim: Some(PersistentVolumeClaimVolumeSource {
                    claim_name: claim_name.clone(),
                    read_only: Some(mount.read_only),
                }),
                ..Default::default()
            },
            MountKind::Bind { source_path } => Volume {
                name,
                host_path: Some(HostPathVolumeSource {
                    path: source_path.clone(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        });
    }
    (volumes, mounts)
}

fn env_vars(
    spec: &SandboxSpec,
    resolved_iron_proxy: Option<&ResolvedIronProxy>,
) -> Option<Vec<EnvVar>> {
    let mut env = BTreeMap::<String, String>::new();
    for item in &spec.env {
        env.insert(item.name.clone(), item.value.clone());
    }
    if let Some(resolved_iron_proxy) = resolved_iron_proxy {
        for (name, value) in &resolved_iron_proxy.placeholder_env {
            env.entry(name.clone()).or_insert_with(|| value.clone());
        }
        for (name, value) in &resolved_iron_proxy.pg_dsn_env {
            env.entry(name.clone()).or_insert_with(|| value.clone());
        }
        let api_host = env
            .get("CENTAUR_API_URL")
            .and_then(|value| host_from_url(value));
        let no_proxy_extra = ["NO_PROXY", "no_proxy"]
            .into_iter()
            .filter_map(|name| env.get(name).map(String::as_str))
            .collect::<Vec<_>>();
        for (name, value) in proxy_env(
            &resolved_iron_proxy.proxy_host,
            resolved_iron_proxy.proxy_port,
            api_host.as_deref(),
            &no_proxy_extra,
        ) {
            env.insert(name, value);
        }
    }
    (!env.is_empty()).then(|| {
        env.into_iter()
            .map(|(name, value)| env_var(&name, &value))
            .collect()
    })
}

fn proxy_env(
    proxy_host: &str,
    proxy_port: u16,
    api_host: Option<&str>,
    no_proxy_extra: &[&str],
) -> BTreeMap<String, String> {
    let proxy_url = format!("http://{proxy_host}:{proxy_port}");
    let no_proxy = no_proxy_value(proxy_host, api_host, no_proxy_extra);
    BTreeMap::from([
        ("FIREWALL_HOST".to_owned(), proxy_host.to_owned()),
        ("FIREWALL_PROXY_PORT".to_owned(), proxy_port.to_string()),
        ("HTTP_PROXY".to_owned(), proxy_url.clone()),
        ("HTTPS_PROXY".to_owned(), proxy_url.clone()),
        ("http_proxy".to_owned(), proxy_url.clone()),
        ("https_proxy".to_owned(), proxy_url),
        ("NO_PROXY".to_owned(), no_proxy.clone()),
        ("no_proxy".to_owned(), no_proxy),
        (
            "NODE_EXTRA_CA_CERTS".to_owned(),
            "/firewall-certs/ca-cert.pem".to_owned(),
        ),
        (
            "REQUESTS_CA_BUNDLE".to_owned(),
            "/firewall-certs/ca-cert.pem".to_owned(),
        ),
        (
            "CURL_CA_BUNDLE".to_owned(),
            "/firewall-certs/ca-cert.pem".to_owned(),
        ),
        (
            "SSL_CERT_FILE".to_owned(),
            "/firewall-certs/ca-cert.pem".to_owned(),
        ),
        (
            "GIT_SSL_CAINFO".to_owned(),
            "/firewall-certs/ca-cert.pem".to_owned(),
        ),
    ])
}

fn proxied_pg_url(host: &str, port: u16, password: &str, database: &str) -> String {
    format!("postgresql://app_user:{password}@{host}:{port}/{database}")
}

fn proxy_password() -> String {
    Uuid::new_v4().simple().to_string()
}

fn no_proxy_value(proxy_host: &str, api_host: Option<&str>, extra_values: &[&str]) -> String {
    let mut hosts = vec![
        "localhost".to_owned(),
        "127.0.0.1".to_owned(),
        "::1".to_owned(),
        proxy_host.to_owned(),
        "api".to_owned(),
        "victoriametrics".to_owned(),
        "victorialogs".to_owned(),
    ];
    if let Some(api_host) = api_host.filter(|value| !value.is_empty()) {
        hosts.push(api_host.to_owned());
    }
    for value in extra_values {
        hosts.extend(
            value
                .split(',')
                .map(str::trim)
                .filter(|host| !host.is_empty())
                .map(ToOwned::to_owned),
        );
    }
    let mut deduped = Vec::new();
    for host in hosts {
        if !deduped.contains(&host) {
            deduped.push(host);
        }
    }
    deduped.join(",")
}

fn host_from_url(value: &str) -> Option<String> {
    let value = value.trim();
    let without_scheme = value
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(value);
    let authority = without_scheme.split('/').next()?.trim();
    let host_port = authority
        .rsplit_once('@')
        .map(|(_, host_port)| host_port)
        .unwrap_or(authority);
    let host = host_port
        .split_once(':')
        .map_or(host_port, |(host, _)| host);
    (!host.is_empty()).then(|| host.to_owned())
}

fn iron_proxy_fragments_for_spec(
    iron_proxy: &IronProxyPodConfig,
    spec: &SandboxSpec,
) -> SandboxResult<Vec<ProxyFragment>> {
    let mut fragments =
        vec![centaur_iron_proxy::infra_fragment().map_err(|err| {
            SandboxError::InvalidSpec(format!("iron-proxy infra fragment: {err}"))
        })?];
    fragments.extend(iron_proxy.fragments.clone());
    for profile in &spec.credential_profiles {
        let harness = profile.as_str();
        let auth_mode = iron_proxy
            .harness_auth_modes
            .get(harness)
            .map(String::as_str)
            .unwrap_or("api_key");
        if let Some(fragment) = centaur_iron_proxy::harness_fragment(harness, auth_mode)
            .map_err(|err| SandboxError::InvalidSpec(format!("iron-proxy fragment: {err}")))?
        {
            fragments.push(fragment);
        }
    }
    Ok(fragments)
}

fn iron_proxy_container(
    iron_proxy: &IronProxyPodConfig,
    resolved: &ResolvedIronProxy,
) -> Container {
    let mut env = BTreeMap::<String, EnvVar>::new();
    if let Some(secret_name) = &iron_proxy.secret_env_name {
        insert_env_secret_ref(
            &mut env,
            "IRON_MANAGEMENT_API_KEY",
            secret_name,
            &iron_proxy.secret_env_prefix,
        );
    } else {
        insert_env_value(
            &mut env,
            "IRON_MANAGEMENT_API_KEY",
            "unused-local-sidecar-key",
        );
    }
    for (name, value) in &iron_proxy.extra_env {
        insert_env_value(&mut env, name, value);
    }
    if let Some(token_broker_name) = &iron_proxy.token_broker_name {
        insert_env_value(
            &mut env,
            "IRON_BROKER_URL",
            token_broker_url(token_broker_name),
        );
    }
    for (name, value) in &resolved.pg_proxy_password_env {
        insert_env_value(&mut env, name, value);
    }
    if let Some(secret_name) = &iron_proxy.secret_env_name {
        if matches!(
            iron_proxy.source_policy.kind,
            SourceKind::OnePasswordConnect
        ) {
            insert_env_secret_ref(
                &mut env,
                "OP_CONNECT_TOKEN",
                secret_name,
                &iron_proxy.secret_env_prefix,
            );
        }
        if iron_proxy.token_broker_name.is_some() {
            insert_env_secret_ref(
                &mut env,
                "IRON_BROKER_TOKEN",
                secret_name,
                &iron_proxy.secret_env_prefix,
            );
        }
    }
    let mut container_ports = vec![
        container_port("proxy", resolved.proxy_port),
        container_port("management", 9092),
        container_port("health", 9090),
    ];
    for port in resolved
        .listen_ports
        .iter()
        .copied()
        .filter(|port| ![resolved.proxy_port, 9092, 9090].contains(port))
    {
        container_ports.push(container_port(format!("tcp-{port}"), port));
    }

    Container {
        name: "iron-proxy".to_owned(),
        image: Some(iron_proxy.image.clone()),
        image_pull_policy: iron_proxy.image_pull_policy.clone(),
        env: Some(env.into_values().collect()),
        env_from: (!iron_proxy.env_from_secret_names.is_empty()).then(|| {
            iron_proxy
                .env_from_secret_names
                .iter()
                .map(|name| EnvFromSource {
                    secret_ref: Some(SecretEnvSource {
                        name: name.clone(),
                        ..Default::default()
                    }),
                    ..Default::default()
                })
                .collect()
        }),
        ports: Some(container_ports),
        readiness_probe: Some(health_probe(Some(5), Some(30))),
        liveness_probe: Some(health_probe(None, None)),
        security_context: Some(SecurityContext {
            allow_privilege_escalation: Some(false),
            capabilities: Some(Capabilities {
                drop: Some(vec!["ALL".to_owned()]),
                ..Default::default()
            }),
            seccomp_profile: Some(SeccompProfile {
                type_: "RuntimeDefault".to_owned(),
                ..Default::default()
            }),
            ..Default::default()
        }),
        volume_mounts: Some(vec![
            volume_mount("iron-proxy-config-rendered", "/etc/iron-proxy-rendered", true),
            volume_mount("iron-proxy-config", "/etc/iron-proxy", false),
            volume_mount("iron-proxy-certs", "/certs", false),
            volume_mount("iron-proxy-ca", "/etc/iron-proxy-ca", true),
        ]),
        command: Some(vec!["/bin/sh".to_owned(), "-ec".to_owned()]),
        args: Some(vec![
            "cp /etc/iron-proxy-rendered/proxy.yaml /etc/iron-proxy/proxy.yaml && exec /entrypoint.sh"
                .to_owned(),
        ]),
        ..Default::default()
    }
}

fn insert_env_value(env: &mut BTreeMap<String, EnvVar>, name: &str, value: impl AsRef<str>) {
    env.insert(name.to_owned(), env_var(name, value.as_ref()));
}

fn insert_env_secret_ref(
    env: &mut BTreeMap<String, EnvVar>,
    name: &str,
    secret_name: &str,
    secret_prefix: &str,
) {
    env.insert(
        name.to_owned(),
        EnvVar {
            name: name.to_owned(),
            value_from: Some(EnvVarSource {
                secret_key_ref: Some(SecretKeySelector {
                    name: secret_name.to_owned(),
                    key: format!("{secret_prefix}{name}"),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        },
    );
}

fn iron_proxy_volumes(id: &SandboxId, iron_proxy: &IronProxyPodConfig) -> Vec<Volume> {
    vec![
        Volume {
            name: "iron-proxy-config-rendered".to_owned(),
            config_map: Some(ConfigMapVolumeSource {
                name: iron_proxy_configmap_name(id),
                ..Default::default()
            }),
            ..Default::default()
        },
        empty_dir_volume("iron-proxy-config"),
        empty_dir_volume("iron-proxy-certs"),
        secret_volume("iron-proxy-ca", iron_proxy.ca_key_secret_name.clone()),
    ]
}

fn build_iron_proxy_pod(
    id: &SandboxId,
    pod_name: &str,
    iron_proxy: &IronProxyPodConfig,
    resolved: &ResolvedIronProxy,
) -> Pod {
    let labels = iron_proxy_labels(id);
    Pod {
        metadata: object_meta(pod_name, labels),
        spec: Some(PodSpec {
            automount_service_account_token: Some(false),
            restart_policy: Some("Never".to_owned()),
            containers: vec![iron_proxy_container(iron_proxy, resolved)],
            volumes: Some(iron_proxy_volumes(id, iron_proxy)),
            image_pull_secrets: image_pull_secret_refs(&iron_proxy.image_pull_secrets),
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn build_iron_proxy_service(id: &SandboxId, resolved: &ResolvedIronProxy) -> Service {
    let mut ports = vec![service_port("proxy", resolved.proxy_port)];
    for port in resolved
        .listen_ports
        .iter()
        .copied()
        .filter(|port| *port != resolved.proxy_port)
    {
        ports.push(service_port(format!("tcp-{port}"), port));
    }
    Service {
        metadata: object_meta(iron_proxy_service_name(id), iron_proxy_labels(id)),
        spec: Some(ServiceSpec {
            selector: Some(iron_proxy_labels(id)),
            ports: Some(ports),
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn build_iron_proxy_network_policies(
    id: &SandboxId,
    resolved: &ResolvedIronProxy,
    iron_proxy: &IronProxyPodConfig,
) -> Vec<NetworkPolicy> {
    let mut sandbox_to_proxy_ports = vec![network_port(resolved.proxy_port)];
    for port in resolved
        .listen_ports
        .iter()
        .copied()
        .filter(|port| *port != resolved.proxy_port)
    {
        sandbox_to_proxy_ports.push(network_port(port));
    }
    let sandbox_policy = NetworkPolicy {
        metadata: object_meta(
            iron_proxy_sandbox_egress_policy_name(id),
            sandbox_labels(id),
        ),
        spec: Some(NetworkPolicySpec {
            pod_selector: Some(label_selector(sandbox_labels(id))),
            policy_types: Some(vec!["Egress".to_owned()]),
            egress: Some(vec![
                egress_to(
                    vec![pod_peer(iron_proxy_labels(id))],
                    sandbox_to_proxy_ports.clone(),
                ),
                egress_to(
                    vec![pod_peer(iron_proxy.api_pod_labels.clone())],
                    vec![network_port(8000)],
                ),
                dns_egress_rule(),
            ]),
            ..Default::default()
        }),
    };
    let mut proxy_egress = vec![
        dns_egress_rule(),
        egress_to(
            vec![pod_peer(iron_proxy.api_pod_labels.clone())],
            vec![network_port(8000)],
        ),
        NetworkPolicyEgressRule {
            ports: Some(vec![network_port(443), network_port(5432)]),
            ..Default::default()
        },
    ];
    if iron_proxy.token_broker_name.is_some() {
        proxy_egress.push(egress_to(
            vec![pod_peer(token_broker_pod_labels())],
            vec![network_port(centaur_iron_proxy::DEFAULT_BROKER_LISTEN_PORT)],
        ));
    }
    if matches!(
        iron_proxy.source_policy.kind,
        SourceKind::OnePasswordConnect
    ) {
        proxy_egress.push(egress_to(
            vec![pod_peer(BTreeMap::from([(
                "app".to_owned(),
                iron_proxy.op_connect_app_name.clone(),
            )]))],
            vec![network_port(iron_proxy.op_connect_port)],
        ));
    }
    let proxy_policy = NetworkPolicy {
        metadata: object_meta(iron_proxy_policy_name(id), iron_proxy_labels(id)),
        spec: Some(NetworkPolicySpec {
            pod_selector: Some(label_selector(iron_proxy_labels(id))),
            policy_types: Some(vec!["Ingress".to_owned(), "Egress".to_owned()]),
            ingress: Some(vec![NetworkPolicyIngressRule {
                from: Some(vec![pod_peer(sandbox_labels(id))]),
                ports: Some(sandbox_to_proxy_ports),
            }]),
            egress: Some(proxy_egress),
        }),
    };
    vec![sandbox_policy, proxy_policy]
}

fn dns_egress_rule() -> NetworkPolicyEgressRule {
    egress_to(
        vec![NetworkPolicyPeer {
            namespace_selector: Some(label_selector(BTreeMap::from([(
                "kubernetes.io/metadata.name".to_owned(),
                "kube-system".to_owned(),
            )]))),
            ..Default::default()
        }],
        vec![udp_port(53), network_port(53)],
    )
}

fn object_meta(name: impl Into<String>, labels: BTreeMap<String, String>) -> ObjectMeta {
    ObjectMeta {
        name: Some(name.into()),
        labels: Some(labels),
        ..Default::default()
    }
}

fn env_var(name: &str, value: &str) -> EnvVar {
    EnvVar {
        name: name.to_owned(),
        value: Some(value.to_owned()),
        ..Default::default()
    }
}

fn container_port(name: impl Into<String>, port: u16) -> ContainerPort {
    ContainerPort {
        name: Some(name.into()),
        container_port: i32::from(port),
        ..Default::default()
    }
}

fn service_port(name: impl Into<String>, port: u16) -> ServicePort {
    let port = i32::from(port);
    ServicePort {
        name: Some(name.into()),
        port,
        target_port: Some(IntOrString::Int(port)),
        protocol: Some("TCP".to_owned()),
        ..Default::default()
    }
}

fn network_port(port: u16) -> NetworkPolicyPort {
    policy_port("TCP", port)
}

fn udp_port(port: u16) -> NetworkPolicyPort {
    policy_port("UDP", port)
}

fn policy_port(protocol: &str, port: u16) -> NetworkPolicyPort {
    NetworkPolicyPort {
        port: Some(IntOrString::Int(i32::from(port))),
        protocol: Some(protocol.to_owned()),
        ..Default::default()
    }
}

fn health_probe(period_seconds: Option<i32>, failure_threshold: Option<i32>) -> Probe {
    Probe {
        http_get: Some(HTTPGetAction {
            path: Some("/healthz".to_owned()),
            port: IntOrString::Int(9090),
            ..Default::default()
        }),
        period_seconds,
        failure_threshold,
        ..Default::default()
    }
}

fn volume_mount(name: &str, mount_path: &str, read_only: bool) -> VolumeMount {
    VolumeMount {
        name: name.to_owned(),
        mount_path: mount_path.to_owned(),
        read_only: read_only.then_some(true),
        ..Default::default()
    }
}

fn empty_dir_volume(name: &str) -> Volume {
    Volume {
        name: name.to_owned(),
        empty_dir: Some(EmptyDirVolumeSource::default()),
        ..Default::default()
    }
}

fn secret_volume(name: &str, secret_name: impl Into<String>) -> Volume {
    Volume {
        name: name.to_owned(),
        secret: Some(SecretVolumeSource {
            secret_name: Some(secret_name.into()),
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn label_selector(match_labels: BTreeMap<String, String>) -> LabelSelector {
    LabelSelector {
        match_labels: Some(match_labels),
        ..Default::default()
    }
}

fn pod_peer(match_labels: BTreeMap<String, String>) -> NetworkPolicyPeer {
    NetworkPolicyPeer {
        pod_selector: Some(label_selector(match_labels)),
        ..Default::default()
    }
}

fn egress_to(to: Vec<NetworkPolicyPeer>, ports: Vec<NetworkPolicyPort>) -> NetworkPolicyEgressRule {
    NetworkPolicyEgressRule {
        to: Some(to),
        ports: Some(ports),
    }
}

fn resources(spec: &SandboxSpec) -> Option<ResourceRequirements> {
    let resources = spec.resources.as_ref()?;
    let mut limits = BTreeMap::new();
    if let Some(cpu_millis) = resources.cpu_millis {
        limits.insert("cpu".to_owned(), Quantity(format!("{cpu_millis}m")));
    }
    if let Some(memory_bytes) = resources.memory_bytes {
        limits.insert("memory".to_owned(), Quantity(memory_bytes.to_string()));
    }
    (!limits.is_empty()).then(|| ResourceRequirements {
        limits: Some(limits),
        ..Default::default()
    })
}

fn iron_proxy_configmap_name(id: &SandboxId) -> String {
    format!("{}-iron-proxy", id.as_str())
}

fn iron_proxy_pod_name(id: &SandboxId) -> String {
    format!("{}-proxy", id.as_str())
}

fn new_iron_proxy_pod_name(id: &SandboxId) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let sequence = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    format!("{}-proxy-{millis}-{sequence}", id.as_str())
}

fn iron_proxy_service_name(id: &SandboxId) -> String {
    format!("{}-proxy", id.as_str())
}

fn iron_proxy_sandbox_egress_policy_name(id: &SandboxId) -> String {
    format!("{}-sandbox-egress", id.as_str())
}

fn iron_proxy_policy_name(id: &SandboxId) -> String {
    format!("{}-proxy-net", id.as_str())
}

fn sandbox_labels(id: &SandboxId) -> BTreeMap<String, String> {
    BTreeMap::from([
        (MANAGED_BY_LABEL.to_owned(), MANAGED_BY_VALUE.to_owned()),
        (SANDBOX_ID_LABEL.to_owned(), id.as_str().to_owned()),
        (MANAGED_LABEL.to_owned(), "true".to_owned()),
    ])
}

fn iron_proxy_labels(id: &SandboxId) -> BTreeMap<String, String> {
    BTreeMap::from([
        (MANAGED_BY_LABEL.to_owned(), MANAGED_BY_VALUE.to_owned()),
        (SANDBOX_ID_LABEL.to_owned(), id.as_str().to_owned()),
        ("centaur.ai/iron-proxy".to_owned(), "true".to_owned()),
    ])
}

fn iron_token_broker_configmap_name(iron_proxy: &IronProxyPodConfig) -> SandboxResult<String> {
    if let Some(name) = iron_proxy.token_broker_configmap_name.as_deref() {
        return Ok(name.to_owned());
    }
    let Some(name) = iron_proxy.token_broker_name.as_deref() else {
        return Err(SandboxError::InvalidSpec(
            "iron-token-broker configmap requires token_broker_name".to_owned(),
        ));
    };
    Ok(format!("{name}-config"))
}

fn token_broker_url(name: &str) -> String {
    format!(
        "http://{name}:{}",
        centaur_iron_proxy::DEFAULT_BROKER_LISTEN_PORT
    )
}

fn token_broker_labels() -> BTreeMap<String, String> {
    let mut labels = token_broker_pod_labels();
    labels.insert(TOKEN_BROKER_LABEL.to_owned(), "true".to_owned());
    labels
}

fn token_broker_pod_labels() -> BTreeMap<String, String> {
    BTreeMap::from([(
        "app.kubernetes.io/component".to_owned(),
        "token-broker".to_owned(),
    )])
}

fn short_sha256(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn image_pull_secret_refs(names: &[String]) -> Option<Vec<LocalObjectReference>> {
    (!names.is_empty()).then(|| {
        names
            .iter()
            .map(|name| LocalObjectReference { name: name.clone() })
            .collect::<Vec<_>>()
    })
}

fn next_sandbox_name() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let sequence = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    format!("asbx-{millis}-{sequence}")
}

fn is_not_found(err: &Error) -> bool {
    matches!(err, Error::Api(api_error) if api_error.code == 404)
}

fn map_kube_error(operation: &str, err: Error) -> SandboxError {
    if is_not_found(&err) {
        SandboxError::NotFound(operation.to_owned())
    } else {
        SandboxError::Backend(format!("{operation}: {err}"))
    }
}

#[cfg(test)]
mod tests;
