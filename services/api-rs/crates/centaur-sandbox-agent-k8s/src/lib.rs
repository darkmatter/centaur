//! Agent Sandbox Kubernetes backend.
//!
//! The Agent Sandbox CRD types are generated from the upstream CRD with
//! `just codegen-agent-sandbox-crd`.

use std::collections::BTreeMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use centaur_iron_proxy::{CorePgListener, ProxyFragment, SourceKind, SourcePolicy};
use centaur_sandbox_core::{
    MountKind, ObservedSandbox, SandboxBackend, SandboxError, SandboxHandle, SandboxId, SandboxIo,
    SandboxResult, SandboxSpec, SandboxStatus,
};
use k8s_openapi::api::core::v1::{ConfigMap, PersistentVolumeClaim, Pod, Service};
use k8s_openapi::api::networking::v1::NetworkPolicy;
use kube::api::{AttachParams, DeleteParams, ListParams, Patch, PatchParams, PostParams};
use kube::{Api, Client, Error};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::{Instant, sleep};

pub use generated::agents_x_k8s_io as crd;

pub mod generated;

const BACKEND_NAME: &str = "agent-sandbox-k8s";
const DEFAULT_CONTAINER_NAME: &str = "agent";
const MANAGED_LABEL: &str = "centaur.ai/managed";
const MANAGED_BY_LABEL: &str = "centaur.ai/managed-by";
const SANDBOX_ID_LABEL: &str = "centaur.ai/sandbox-id";
const MANAGED_BY_VALUE: &str = "api-rs";

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
pub struct AgentSandboxConfig {
    pub namespace: String,
    pub field_manager: String,
    pub container_name: String,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub image_pull_policy: Option<String>,
    pub state_volume: Option<StateVolumeConfig>,
    pub iron_proxy: Option<IronProxyPodConfig>,
    pub ready_timeout: Duration,
}

impl AgentSandboxConfig {
    pub fn new(namespace: impl Into<String>) -> Self {
        Self {
            namespace: namespace.into(),
            field_manager: "centaur-api-rs".to_owned(),
            container_name: DEFAULT_CONTAINER_NAME.to_owned(),
            labels: BTreeMap::new(),
            annotations: BTreeMap::new(),
            image_pull_policy: None,
            state_volume: None,
            iron_proxy: None,
            ready_timeout: Duration::from_secs(60),
        }
    }

    pub fn state_volume(mut self, state_volume: StateVolumeConfig) -> Self {
        self.state_volume = Some(state_volume);
        self
    }
}

#[derive(Clone, Debug)]
pub struct IronProxyPodConfig {
    pub image: String,
    pub image_pull_policy: Option<String>,
    pub fragments: Vec<ProxyFragment>,
    pub source_policy: SourcePolicy,
    pub core_pg: Option<CorePgListener>,
    pub harness_auth_modes: BTreeMap<String, String>,
    pub ca_cert_secret_name: String,
    pub ca_key_secret_name: String,
    pub op_connect_app_name: String,
    pub op_connect_port: u16,
    pub api_pod_labels: BTreeMap<String, String>,
    pub env_from_secret_names: Vec<String>,
    pub extra_env: BTreeMap<String, String>,
}

impl IronProxyPodConfig {
    pub fn new(
        image: impl Into<String>,
        ca_cert_secret_name: impl Into<String>,
        ca_key_secret_name: impl Into<String>,
    ) -> Self {
        Self {
            image: image.into(),
            image_pull_policy: None,
            fragments: Vec::new(),
            source_policy: SourcePolicy::default(),
            core_pg: None,
            harness_auth_modes: BTreeMap::new(),
            ca_cert_secret_name: ca_cert_secret_name.into(),
            ca_key_secret_name: ca_key_secret_name.into(),
            op_connect_app_name: "onepassword-connect".to_owned(),
            op_connect_port: 8080,
            api_pod_labels: BTreeMap::from([(
                "app.kubernetes.io/component".to_owned(),
                "api".to_owned(),
            )]),
            env_from_secret_names: Vec::new(),
            extra_env: BTreeMap::new(),
        }
    }

    pub fn with_fragments(mut self, fragments: Vec<ProxyFragment>) -> Self {
        self.fragments = fragments;
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ResolvedIronProxy {
    config_yaml: String,
    placeholder_env: BTreeMap<String, String>,
    proxy_host: String,
    proxy_pod_name: String,
    listen_ports: Vec<u16>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StateVolumeConfig {
    pub mount_path: String,
    pub size: String,
    pub storage_class_name: Option<String>,
}

impl StateVolumeConfig {
    pub fn new(mount_path: impl Into<String>, size: impl Into<String>) -> Self {
        Self {
            mount_path: mount_path.into(),
            size: size.into(),
            storage_class_name: None,
        }
    }

    pub fn storage_class_name(mut self, storage_class_name: impl Into<String>) -> Self {
        self.storage_class_name = Some(storage_class_name.into());
        self
    }
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

    fn persistent_volume_claims(&self) -> Api<PersistentVolumeClaim> {
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

    async fn delete_state_pvc(&self, id: &SandboxId) -> SandboxResult<()> {
        if self.config.state_volume.is_none() {
            return Ok(());
        }
        match self
            .persistent_volume_claims()
            .delete(&state_pvc_name(id), &DeleteParams::default())
            .await
        {
            Ok(_) => Ok(()),
            Err(err) if is_not_found(&err) => Ok(()),
            Err(err) => Err(map_kube_error("delete sandbox state pvc", err)),
        }
    }

    fn resolve_iron_proxy(
        &self,
        id: &SandboxId,
        spec: &SandboxSpec,
    ) -> SandboxResult<Option<ResolvedIronProxy>> {
        let Some(iron_proxy) = &self.config.iron_proxy else {
            return Ok(None);
        };
        let mut fragments = vec![centaur_iron_proxy::infra_fragment().map_err(|err| {
            SandboxError::InvalidSpec(format!("iron-proxy infra fragment: {err}"))
        })?];
        fragments.extend(iron_proxy.fragments.clone());
        if let Some(harness) = spec_env(spec, "CENTAUR_HARNESS_KIND") {
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
        let config_yaml = centaur_iron_proxy::render_proxy_yaml_with_source_policy(
            None,
            &fragments,
            iron_proxy.core_pg.as_ref(),
            &iron_proxy.source_policy,
        )
        .map_err(|err| SandboxError::InvalidSpec(format!("iron-proxy config: {err}")))?;
        let placeholder_env = centaur_iron_proxy::placeholder_env(&fragments);
        let listen_ports = centaur_iron_proxy::listen_ports_from_yaml(&config_yaml)
            .map_err(|err| SandboxError::InvalidSpec(format!("iron-proxy listen ports: {err}")))?;
        Ok(Some(ResolvedIronProxy {
            config_yaml,
            placeholder_env,
            proxy_host: iron_proxy_service_name(id),
            proxy_pod_name: new_iron_proxy_pod_name(id),
            listen_ports,
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
        let mut data = BTreeMap::new();
        data.insert("proxy.yaml".to_owned(), resolved.config_yaml.clone());
        let body = ConfigMap {
            metadata: k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta {
                name: Some(name),
                labels: Some(iron_proxy_labels(id)),
                ..Default::default()
            },
            data: Some(data),
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

    async fn create_iron_proxy_resources(
        &self,
        id: &SandboxId,
        resolved: Option<&ResolvedIronProxy>,
    ) -> SandboxResult<()> {
        let Some(resolved) = resolved else {
            return Ok(());
        };
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
        let service = build_iron_proxy_service(id, resolved)?;
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
        let pod = build_iron_proxy_pod(id, &resolved.proxy_pod_name, iron_proxy)?;
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
        for policy in build_iron_proxy_network_policies(id, resolved, iron_proxy)? {
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
            Ok(_) => self.delete_state_pvc(id).await,
            Err(err) if is_not_found(&err) => self.delete_state_pvc(id).await,
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

    let mut container = json!({
        "name": config.container_name,
        "image": spec.image,
        "stdin": true,
        "stdinOnce": false,
        "tty": false,
    });
    insert_optional(
        &mut container,
        "imagePullPolicy",
        config.image_pull_policy.clone(),
    );
    insert_optional(&mut container, "command", spec.command.clone());
    insert_optional(
        &mut container,
        "args",
        (!spec.args.is_empty()).then(|| spec.args.clone()),
    );
    insert_optional(
        &mut container,
        "env",
        (!spec.env.is_empty() || resolved_iron_proxy.is_some())
            .then(|| env_json(spec, resolved_iron_proxy)),
    );
    insert_optional(&mut container, "workingDir", spec.working_dir.clone());
    insert_optional(&mut container, "resources", resources_json(spec));

    let (mut volumes, mut volume_mounts) = mount_json(spec);
    if let Some(state_volume) = &config.state_volume {
        volume_mounts.push(json!({
            "name": "state",
            "mountPath": state_volume.mount_path,
        }));
    }
    if let Some(iron_proxy) = &config.iron_proxy {
        volume_mounts.push(json!({
            "name": "iron-proxy-ca-cert",
            "mountPath": "/firewall-certs",
            "readOnly": true,
        }));
        volumes.push(json!({
            "name": "iron-proxy-ca-cert",
            "secret": {"secretName": iron_proxy.ca_cert_secret_name}
        }));
    }
    insert_optional(
        &mut container,
        "volumeMounts",
        (!volume_mounts.is_empty()).then_some(volume_mounts),
    );
    let mut pod_spec = json!({
        "containers": [container],
        "restartPolicy": "Never",
        "automountServiceAccountToken": false,
    });
    insert_optional(
        &mut pod_spec,
        "volumes",
        (!volumes.is_empty()).then(|| std::mem::take(&mut volumes)),
    );

    let mut agent_spec = json!({
        "replicas": 1,
        "service": false,
        "shutdownPolicy": "Retain",
        "podTemplate": {
            "metadata": {
                "labels": pod_labels,
                "annotations": config.annotations,
            },
            "spec": pod_spec,
        },
    });
    insert_optional(
        &mut agent_spec,
        "volumeClaimTemplates",
        config.state_volume.as_ref().map(state_volume_claim_json),
    );

    let spec = serde_json::from_value(agent_spec)
        .map_err(|err| SandboxError::InvalidSpec(format!("invalid Agent Sandbox spec: {err}")))?;
    let mut sandbox = crd::Sandbox::new(id.as_str(), spec);
    sandbox.metadata.labels = Some(labels);
    sandbox.metadata.annotations = Some(config.annotations.clone());
    Ok(sandbox)
}

fn mount_json(spec: &SandboxSpec) -> (Vec<Value>, Vec<Value>) {
    let mut volumes = Vec::with_capacity(spec.mounts.len());
    let mut mounts = Vec::with_capacity(spec.mounts.len());
    for (index, mount) in spec.mounts.iter().enumerate() {
        let name = format!("mount-{index}");
        mounts.push(json!({
            "name": name,
            "mountPath": mount.target_path,
            "readOnly": mount.read_only,
        }));
        volumes.push(match &mount.kind {
            MountKind::EmptyDir => json!({
                "name": name,
                "emptyDir": {},
            }),
            MountKind::NamedVolume(claim_name) => json!({
                "name": name,
                "persistentVolumeClaim": {
                    "claimName": claim_name,
                    "readOnly": mount.read_only,
                },
            }),
            MountKind::Bind { source_path } => json!({
                "name": name,
                "hostPath": {
                    "path": source_path,
                },
            }),
        });
    }
    (volumes, mounts)
}

fn env_json(spec: &SandboxSpec, resolved_iron_proxy: Option<&ResolvedIronProxy>) -> Vec<Value> {
    let mut env = BTreeMap::<String, String>::new();
    for item in &spec.env {
        env.insert(item.name.clone(), item.value.clone());
    }
    if let Some(resolved_iron_proxy) = resolved_iron_proxy {
        for (name, value) in &resolved_iron_proxy.placeholder_env {
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
            api_host.as_deref(),
            &no_proxy_extra,
        ) {
            env.insert(name, value);
        }
    }
    env.into_iter()
        .map(|(name, value)| json!({ "name": name, "value": value }))
        .collect()
}

fn proxy_env(
    proxy_host: &str,
    api_host: Option<&str>,
    no_proxy_extra: &[&str],
) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    let proxy_url = format!("http://{proxy_host}:8080");
    let no_proxy = no_proxy_value(proxy_host, api_host, no_proxy_extra);
    env.insert("FIREWALL_HOST".to_owned(), proxy_host.to_owned());
    env.insert("HTTP_PROXY".to_owned(), proxy_url.clone());
    env.insert("HTTPS_PROXY".to_owned(), proxy_url.clone());
    env.insert("http_proxy".to_owned(), proxy_url.clone());
    env.insert("https_proxy".to_owned(), proxy_url);
    env.insert("NO_PROXY".to_owned(), no_proxy.clone());
    env.insert("no_proxy".to_owned(), no_proxy);
    env.insert(
        "NODE_EXTRA_CA_CERTS".to_owned(),
        "/firewall-certs/ca-cert.pem".to_owned(),
    );
    env.insert(
        "REQUESTS_CA_BUNDLE".to_owned(),
        "/firewall-certs/ca-cert.pem".to_owned(),
    );
    env.insert(
        "SSL_CERT_FILE".to_owned(),
        "/firewall-certs/ca-cert.pem".to_owned(),
    );
    env.insert(
        "GIT_SSL_CAINFO".to_owned(),
        "/firewall-certs/ca-cert.pem".to_owned(),
    );
    env
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

fn spec_env<'a>(spec: &'a SandboxSpec, name: &str) -> Option<&'a str> {
    spec.env
        .iter()
        .rev()
        .find(|item| item.name == name)
        .map(|item| item.value.as_str())
        .filter(|value| !value.trim().is_empty())
}

fn iron_proxy_container(iron_proxy: &IronProxyPodConfig) -> Value {
    let mut env = BTreeMap::new();
    env.insert(
        "IRON_MANAGEMENT_API_KEY".to_owned(),
        "unused-local-sidecar-key".to_owned(),
    );
    for (name, value) in &iron_proxy.extra_env {
        env.insert(name.clone(), value.clone());
    }
    let mut container = json!({
        "name": "iron-proxy",
        "image": iron_proxy.image,
        "env": env.into_iter().map(|(name, value)| json!({ "name": name, "value": value })).collect::<Vec<_>>(),
        "ports": [
            {"containerPort": 8080, "name": "proxy"},
            {"containerPort": 9092, "name": "management"},
            {"containerPort": 9090, "name": "health"}
        ],
        "readinessProbe": {
            "httpGet": {
                "path": "/healthz",
                "port": 9090
            },
            "periodSeconds": 5,
            "failureThreshold": 30
        },
        "livenessProbe": {
            "httpGet": {
                "path": "/healthz",
                "port": 9090
            }
        },
        "securityContext": {
            "allowPrivilegeEscalation": false,
            "capabilities": {"drop": ["ALL"]},
            "seccompProfile": {"type": "RuntimeDefault"}
        },
        "volumeMounts": [
            {
                "name": "iron-proxy-config-rendered",
                "mountPath": "/etc/iron-proxy-rendered",
                "readOnly": true
            },
            {
                "name": "iron-proxy-config",
                "mountPath": "/etc/iron-proxy"
            },
            {
                "name": "iron-proxy-certs",
                "mountPath": "/certs"
            },
            {
                "name": "iron-proxy-ca",
                "mountPath": "/etc/iron-proxy-ca",
                "readOnly": true
            }
        ],
        "command": ["/bin/sh", "-ec"],
        "args": [
            "cp /etc/iron-proxy-rendered/proxy.yaml /etc/iron-proxy/proxy.yaml && exec /entrypoint.sh"
        ]
    });
    insert_optional(
        &mut container,
        "imagePullPolicy",
        iron_proxy.image_pull_policy.clone(),
    );
    insert_optional(
        &mut container,
        "envFrom",
        (!iron_proxy.env_from_secret_names.is_empty()).then(|| {
            iron_proxy
                .env_from_secret_names
                .iter()
                .map(|name| json!({ "secretRef": { "name": name } }))
                .collect::<Vec<_>>()
        }),
    );
    container
}

fn iron_proxy_volumes(id: &SandboxId, iron_proxy: &IronProxyPodConfig) -> Vec<Value> {
    vec![
        json!({
            "name": "iron-proxy-config-rendered",
            "configMap": {"name": iron_proxy_configmap_name(id)}
        }),
        json!({"name": "iron-proxy-config", "emptyDir": {}}),
        json!({"name": "iron-proxy-certs", "emptyDir": {}}),
        json!({
            "name": "iron-proxy-ca",
            "secret": {"secretName": iron_proxy.ca_key_secret_name}
        }),
    ]
}

fn build_iron_proxy_pod(
    id: &SandboxId,
    pod_name: &str,
    iron_proxy: &IronProxyPodConfig,
) -> SandboxResult<Pod> {
    let labels = iron_proxy_labels(id);
    let pod = json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": pod_name,
            "labels": labels,
        },
        "spec": {
            "automountServiceAccountToken": false,
            "restartPolicy": "Never",
            "containers": [iron_proxy_container(iron_proxy)],
            "volumes": iron_proxy_volumes(id, iron_proxy),
        },
    });
    serde_json::from_value(pod)
        .map_err(|err| SandboxError::InvalidSpec(format!("invalid iron-proxy pod: {err}")))
}

fn build_iron_proxy_service(
    id: &SandboxId,
    resolved: &ResolvedIronProxy,
) -> SandboxResult<Service> {
    let mut ports = vec![json!({
        "name": "proxy",
        "port": 8080,
        "targetPort": 8080,
        "protocol": "TCP",
    })];
    for port in resolved
        .listen_ports
        .iter()
        .copied()
        .filter(|port| *port != 8080)
    {
        ports.push(json!({
            "name": format!("tcp-{port}"),
            "port": port,
            "targetPort": port,
            "protocol": "TCP",
        }));
    }
    let service = json!({
        "apiVersion": "v1",
        "kind": "Service",
        "metadata": {
            "name": iron_proxy_service_name(id),
            "labels": iron_proxy_labels(id),
        },
        "spec": {
            "selector": iron_proxy_labels(id),
            "ports": ports,
        },
    });
    serde_json::from_value(service)
        .map_err(|err| SandboxError::InvalidSpec(format!("invalid iron-proxy service: {err}")))
}

fn build_iron_proxy_network_policies(
    id: &SandboxId,
    resolved: &ResolvedIronProxy,
    iron_proxy: &IronProxyPodConfig,
) -> SandboxResult<Vec<NetworkPolicy>> {
    let mut sandbox_to_proxy_ports = vec![json!({"protocol": "TCP", "port": 8080})];
    for port in resolved
        .listen_ports
        .iter()
        .copied()
        .filter(|port| *port != 8080)
    {
        sandbox_to_proxy_ports.push(json!({"protocol": "TCP", "port": port}));
    }
    let sandbox_policy = json!({
        "apiVersion": "networking.k8s.io/v1",
        "kind": "NetworkPolicy",
        "metadata": {
            "name": iron_proxy_sandbox_egress_policy_name(id),
            "labels": sandbox_labels(id),
        },
        "spec": {
            "podSelector": {"matchLabels": sandbox_labels(id)},
            "policyTypes": ["Egress"],
            "egress": [
                {
                    "to": [{"podSelector": {"matchLabels": iron_proxy_labels(id)}}],
                    "ports": sandbox_to_proxy_ports.clone(),
                },
                {
                    "to": [{"podSelector": {"matchLabels": iron_proxy.api_pod_labels.clone()}}],
                    "ports": [{"protocol": "TCP", "port": 8000}],
                },
                {
                    "ports": [
                        {"protocol": "UDP", "port": 53},
                        {"protocol": "TCP", "port": 53},
                    ],
                },
            ],
        },
    });
    let mut proxy_egress = vec![
        json!({
            "ports": [
                {"protocol": "UDP", "port": 53},
                {"protocol": "TCP", "port": 53},
            ],
        }),
        json!({
            "to": [{"podSelector": {"matchLabels": iron_proxy.api_pod_labels.clone()}}],
            "ports": [{"protocol": "TCP", "port": 8000}],
        }),
        json!({
            "ports": [
                {"protocol": "TCP", "port": 443},
                {"protocol": "TCP", "port": 5432},
                {"protocol": "TCP", "port": 8181},
            ],
        }),
    ];
    if matches!(
        iron_proxy.source_policy.kind,
        SourceKind::OnePasswordConnect
    ) {
        proxy_egress.push(json!({
            "to": [{"podSelector": {"matchLabels": {"app": iron_proxy.op_connect_app_name}}}],
            "ports": [{"protocol": "TCP", "port": iron_proxy.op_connect_port}],
        }));
    }
    let proxy_policy = json!({
        "apiVersion": "networking.k8s.io/v1",
        "kind": "NetworkPolicy",
        "metadata": {
            "name": iron_proxy_policy_name(id),
            "labels": iron_proxy_labels(id),
        },
        "spec": {
            "podSelector": {"matchLabels": iron_proxy_labels(id)},
            "policyTypes": ["Ingress", "Egress"],
            "ingress": [
                {
                    "from": [{"podSelector": {"matchLabels": sandbox_labels(id)}}],
                    "ports": sandbox_to_proxy_ports,
                }
            ],
            "egress": proxy_egress,
        },
    });
    [sandbox_policy, proxy_policy]
        .into_iter()
        .map(|policy| {
            serde_json::from_value(policy).map_err(|err| {
                SandboxError::InvalidSpec(format!("invalid iron-proxy network policy: {err}"))
            })
        })
        .collect()
}

fn resources_json(spec: &SandboxSpec) -> Option<Value> {
    let resources = spec.resources.as_ref()?;
    let mut limits = serde_json::Map::new();
    if let Some(cpu_millis) = resources.cpu_millis {
        limits.insert("cpu".to_owned(), json!(format!("{cpu_millis}m")));
    }
    if let Some(memory_bytes) = resources.memory_bytes {
        limits.insert("memory".to_owned(), json!(format!("{memory_bytes}")));
    }
    (!limits.is_empty()).then(|| json!({ "limits": limits }))
}

fn state_volume_claim_json(state_volume: &StateVolumeConfig) -> Vec<Value> {
    let mut pvc_spec = json!({
        "accessModes": ["ReadWriteOnce"],
        "resources": {
            "requests": {
                "storage": state_volume.size,
            },
        },
    });
    insert_optional(
        &mut pvc_spec,
        "storageClassName",
        state_volume.storage_class_name.clone(),
    );
    vec![json!({
        "metadata": {
            "name": "state",
        },
        "spec": pvc_spec,
    })]
}

fn state_pvc_name(id: &SandboxId) -> String {
    format!("state-{}", id.as_str())
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
    let mut labels = base_resource_labels(id);
    labels.insert(MANAGED_LABEL.to_owned(), "true".to_owned());
    labels
}

fn iron_proxy_labels(id: &SandboxId) -> BTreeMap<String, String> {
    let mut labels = base_resource_labels(id);
    labels.insert("centaur.ai/iron-proxy".to_owned(), "true".to_owned());
    labels
}

fn base_resource_labels(id: &SandboxId) -> BTreeMap<String, String> {
    BTreeMap::from([
        (MANAGED_BY_LABEL.to_owned(), MANAGED_BY_VALUE.to_owned()),
        (SANDBOX_ID_LABEL.to_owned(), id.as_str().to_owned()),
    ])
}

fn insert_optional<T>(target: &mut Value, key: &str, value: Option<T>)
where
    T: serde::Serialize,
{
    if let Some(value) = value {
        target[key] = json!(value);
    }
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
mod tests {
    use centaur_sandbox_core::{ResourceLimits, SandboxSpec};
    use k8s_openapi::api::core::v1::{PodCondition, PodStatus};
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{StatusCause, StatusDetails};
    use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;

    use super::*;

    #[test]
    fn builds_agent_sandbox_spec_with_state_volume_and_limits() {
        let spec = SandboxSpec::new("centaur-agent:latest")
            .command(["/bin/sh", "-lc"])
            .args(["cat"])
            .env("CENTAUR_API_URL", "http://api:8000")
            .mount(centaur_sandbox_core::Mount::new(
                MountKind::EmptyDir,
                "/workspace",
            ))
            .resources(
                ResourceLimits::new()
                    .cpu_millis(500)
                    .memory_bytes(512 * 1024 * 1024),
            );
        let config = AgentSandboxConfig::new("centaur")
            .state_volume(StateVolumeConfig::new("/home/agent/state", "10Gi"));

        let sandbox =
            build_agent_sandbox(&SandboxId::new("asbx-test"), &spec, &config, None).unwrap();

        assert_eq!(sandbox.metadata.name.as_deref(), Some("asbx-test"));
        assert_eq!(sandbox.spec.replicas, Some(1));
        assert_eq!(
            sandbox.spec.shutdown_policy,
            Some(crd::SandboxShutdownPolicy::Retain)
        );
        assert_eq!(
            sandbox.spec.volume_claim_templates.as_ref().unwrap().len(),
            1
        );
        let container = &sandbox.spec.pod_template.spec.containers[0];
        assert_eq!(container.image.as_deref(), Some("centaur-agent:latest"));
        assert_eq!(container.stdin, Some(true));
        assert_eq!(container.volume_mounts.as_ref().unwrap().len(), 2);
        assert!(container.resources.as_ref().unwrap().limits.is_some());
    }

    #[test]
    fn builds_agent_sandbox_with_iron_proxy_env_and_ca_mount() {
        let mut config = AgentSandboxConfig::new("centaur");
        config.iron_proxy = Some(IronProxyPodConfig::new(
            "centaur-iron-proxy:latest",
            "firewall-ca-cert",
            "firewall-ca-key",
        ));
        let resolved = ResolvedIronProxy {
            config_yaml: "transforms: []\n".to_owned(),
            placeholder_env: BTreeMap::from([(
                "OPENAI_API_KEY".to_owned(),
                "OPENAI_API_KEY".to_owned(),
            )]),
            proxy_host: "asbx-test-proxy".to_owned(),
            proxy_pod_name: "asbx-test-proxy-123".to_owned(),
            listen_ports: vec![8080],
        };
        let spec = SandboxSpec::new("centaur-agent:latest")
            .env("CENTAUR_API_URL", "http://centaur-centaur-api:8000")
            .env("NO_PROXY", "otel.local")
            .env("CENTAUR_HARNESS_KIND", "codex");

        let sandbox = build_agent_sandbox(
            &SandboxId::new("asbx-test"),
            &spec,
            &config,
            Some(&resolved),
        )
        .unwrap();
        let pod_spec = &sandbox.spec.pod_template.spec;
        let containers = &pod_spec.containers;
        assert_eq!(containers.len(), 1);
        assert_eq!(containers[0].name, "agent");
        assert_eq!(
            sandbox
                .spec
                .pod_template
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.labels.as_ref())
                .unwrap()
                .get(MANAGED_LABEL),
            Some(&"true".to_owned())
        );
        let agent_env = containers[0]
            .env
            .as_ref()
            .unwrap()
            .iter()
            .map(|env| (env.name.as_str(), env.value.as_deref().unwrap_or("")))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(agent_env["OPENAI_API_KEY"], "OPENAI_API_KEY");
        assert_eq!(agent_env["FIREWALL_HOST"], "asbx-test-proxy");
        assert_eq!(agent_env["HTTPS_PROXY"], "http://asbx-test-proxy:8080");
        assert!(agent_env["NO_PROXY"].contains("asbx-test-proxy"));
        assert!(agent_env["NO_PROXY"].contains("centaur-centaur-api"));
        assert!(agent_env["NO_PROXY"].contains("otel.local"));
        assert_eq!(
            agent_env["REQUESTS_CA_BUNDLE"],
            "/firewall-certs/ca-cert.pem"
        );
        assert!(
            containers[0]
                .volume_mounts
                .as_ref()
                .unwrap()
                .iter()
                .any(|mount| mount.name == "iron-proxy-ca-cert"
                    && mount.mount_path == "/firewall-certs"
                    && mount.read_only == Some(true))
        );
        let volumes = pod_spec.volumes.as_ref().unwrap();
        assert!(
            volumes
                .iter()
                .any(|volume| volume.name == "iron-proxy-ca-cert"
                    && volume.secret.as_ref().unwrap().secret_name.as_deref()
                        == Some("firewall-ca-cert"))
        );
        assert!(
            !volumes
                .iter()
                .any(|volume| volume.name == "iron-proxy-config-rendered")
        );
    }

    #[test]
    fn builds_iron_proxy_resources_for_sandbox() {
        let id = SandboxId::new("asbx-test");
        let mut iron_proxy = IronProxyPodConfig::new(
            "centaur-iron-proxy:latest",
            "firewall-ca-cert",
            "firewall-ca-key",
        );
        iron_proxy.source_policy = SourcePolicy::onepassword_connect("ai-agents", "10m");
        iron_proxy
            .env_from_secret_names
            .push("centaur-infra-env".to_owned());
        iron_proxy.extra_env.insert(
            "OP_CONNECT_HOST".to_owned(),
            "http://op-connect:8080".to_owned(),
        );
        let resolved = ResolvedIronProxy {
            config_yaml: "transforms: []\n".to_owned(),
            placeholder_env: BTreeMap::new(),
            proxy_host: "asbx-test-proxy".to_owned(),
            proxy_pod_name: "asbx-test-proxy-123".to_owned(),
            listen_ports: vec![5432, 8080],
        };

        let pod = build_iron_proxy_pod(&id, &resolved.proxy_pod_name, &iron_proxy).unwrap();
        assert_eq!(pod.metadata.name.as_deref(), Some("asbx-test-proxy-123"));
        let pod_labels = pod.metadata.labels.as_ref().unwrap();
        assert_eq!(
            pod_labels.get("centaur.ai/iron-proxy"),
            Some(&"true".to_owned())
        );
        assert!(!pod_labels.contains_key(MANAGED_LABEL));
        let container = &pod.spec.as_ref().unwrap().containers[0];
        assert_eq!(container.name, "iron-proxy");
        assert_eq!(
            container.image.as_deref(),
            Some("centaur-iron-proxy:latest")
        );
        assert_eq!(
            container.env_from.as_ref().unwrap()[0]
                .secret_ref
                .as_ref()
                .unwrap()
                .name
                .as_str(),
            "centaur-infra-env"
        );
        assert_eq!(
            container
                .readiness_probe
                .as_ref()
                .unwrap()
                .http_get
                .as_ref()
                .unwrap()
                .port,
            IntOrString::Int(9090)
        );
        let volumes = pod.spec.as_ref().unwrap().volumes.as_ref().unwrap();
        assert!(
            volumes
                .iter()
                .any(|volume| volume.name == "iron-proxy-config-rendered"
                    && volume.config_map.as_ref().unwrap().name == "asbx-test-iron-proxy")
        );
        assert!(volumes.iter().any(|volume| volume.name == "iron-proxy-ca"
            && volume.secret.as_ref().unwrap().secret_name.as_deref() == Some("firewall-ca-key")));

        let service = build_iron_proxy_service(&id, &resolved).unwrap();
        assert_eq!(service.metadata.name.as_deref(), Some("asbx-test-proxy"));
        let service_ports = service
            .spec
            .as_ref()
            .unwrap()
            .ports
            .as_ref()
            .unwrap()
            .iter()
            .map(|port| (port.name.as_deref().unwrap_or(""), port.port))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(service_ports["proxy"], 8080);
        assert_eq!(service_ports["tcp-5432"], 5432);

        let policies = build_iron_proxy_network_policies(&id, &resolved, &iron_proxy).unwrap();
        assert_eq!(policies.len(), 2);
        let policy_json = policies
            .iter()
            .map(|policy| {
                (
                    policy.metadata.name.as_deref().unwrap().to_owned(),
                    serde_json::to_value(policy).unwrap(),
                )
            })
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            policy_json["asbx-test-sandbox-egress"]["spec"]["podSelector"]["matchLabels"]
                [MANAGED_LABEL],
            "true"
        );
        assert_eq!(
            policy_json["asbx-test-proxy-net"]["spec"]["podSelector"]["matchLabels"]["centaur.ai/iron-proxy"],
            "true"
        );
        assert_eq!(
            policy_json["asbx-test-sandbox-egress"]["spec"]["egress"][1]["to"][0]["podSelector"]["matchLabels"]
                ["app.kubernetes.io/component"],
            "api"
        );
        assert!(
            policy_json["asbx-test-proxy-net"]["spec"]["egress"]
                .as_array()
                .unwrap()
                .iter()
                .any(|rule| rule["ports"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|port| port["port"] == 443))
        );
        assert!(
            policy_json["asbx-test-proxy-net"]["spec"]["egress"]
                .as_array()
                .unwrap()
                .iter()
                .any(|rule| rule["to"][0]["podSelector"]["matchLabels"]["app"]
                    == "onepassword-connect"
                    && rule["ports"][0]["port"] == 8080)
        );
    }

    #[test]
    fn maps_agent_sandbox_replicas_and_pod_readiness_to_status() {
        let ready_pod = pod_with_phase_and_ready("Running", true);
        assert_eq!(
            sandbox_status_from_pod(0, Some(&ready_pod)),
            SandboxStatus::Suspended
        );
        assert_eq!(
            sandbox_status_from_pod(1, Some(&ready_pod)),
            SandboxStatus::Running
        );

        let unready_pod = pod_with_phase_and_ready("Running", false);
        assert_eq!(
            sandbox_status_from_pod(1, Some(&unready_pod)),
            SandboxStatus::Created
        );
        assert_eq!(sandbox_status_from_pod(1, None), SandboxStatus::Created);

        let failed_pod = pod_with_phase_and_ready("Failed", false);
        assert_eq!(
            sandbox_status_from_pod(1, Some(&failed_pod)),
            SandboxStatus::Stopped
        );
    }

    #[test]
    fn state_pvc_name_matches_agent_sandbox_template() {
        assert_eq!(
            state_pvc_name(&SandboxId::new("asbx-test")),
            "state-asbx-test"
        );
    }

    fn pod_with_phase_and_ready(phase: &str, ready: bool) -> Pod {
        Pod {
            status: Some(PodStatus {
                phase: Some(phase.to_owned()),
                conditions: Some(vec![PodCondition {
                    type_: "Ready".to_owned(),
                    status: if ready { "True" } else { "False" }.to_owned(),
                    ..PodCondition::default()
                }]),
                ..PodStatus::default()
            }),
            ..Pod::default()
        }
    }
}
