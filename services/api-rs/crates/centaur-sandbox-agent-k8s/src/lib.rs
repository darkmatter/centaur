//! Agent Sandbox Kubernetes backend.
//!
//! The Agent Sandbox CRD types are generated from the upstream CRD with
//! `just codegen-agent-sandbox-crd`.

use std::collections::BTreeMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use centaur_iron_proxy::{CorePgListener, ProxyFragment, SourcePolicy};
use centaur_sandbox_core::{
    MountKind, ObservedSandbox, SandboxBackend, SandboxError, SandboxHandle, SandboxId, SandboxIo,
    SandboxResult, SandboxSpec, SandboxStatus,
};
use k8s_openapi::api::core::v1::{ConfigMap, PersistentVolumeClaim, Pod};
use kube::api::{AttachParams, DeleteParams, ListParams, Patch, PatchParams, PostParams};
use kube::{Api, Client, Error};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::{Instant, sleep};

pub use generated::agents_x_k8s_io as crd;

pub mod generated;

const BACKEND_NAME: &str = "agent-sandbox-k8s";
const DEFAULT_CONTAINER_NAME: &str = "agent";
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
    pub ca_secret_name: String,
    pub env_from_secret_name: Option<String>,
    pub extra_env: BTreeMap<String, String>,
}

impl IronProxyPodConfig {
    pub fn new(image: impl Into<String>, ca_secret_name: impl Into<String>) -> Self {
        Self {
            image: image.into(),
            image_pull_policy: None,
            fragments: Vec::new(),
            source_policy: SourcePolicy::default(),
            core_pg: None,
            harness_auth_modes: BTreeMap::new(),
            ca_secret_name: ca_secret_name.into(),
            env_from_secret_name: None,
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

    fn resolve_iron_proxy(&self, spec: &SandboxSpec) -> SandboxResult<Option<ResolvedIronProxy>> {
        let Some(iron_proxy) = &self.config.iron_proxy else {
            return Ok(None);
        };
        let mut fragments = iron_proxy.fragments.clone();
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
        Ok(Some(ResolvedIronProxy {
            config_yaml,
            placeholder_env,
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
        let mut labels = BTreeMap::new();
        labels.insert(MANAGED_BY_LABEL.to_owned(), MANAGED_BY_VALUE.to_owned());
        labels.insert(SANDBOX_ID_LABEL.to_owned(), id.as_str().to_owned());
        let body = ConfigMap {
            metadata: k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta {
                name: Some(name),
                labels: Some(labels),
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
        let resolved_iron_proxy = self.resolve_iron_proxy(&spec)?;
        self.create_iron_proxy_configmap(&id, resolved_iron_proxy.as_ref())
            .await?;
        let sandbox = build_agent_sandbox(&id, &spec, &self.config, resolved_iron_proxy.as_ref())?;
        let create_result = self
            .sandboxes()
            .create(&PostParams::default(), &sandbox)
            .await
            .map_err(|err| map_kube_error("create sandbox", err));
        if let Err(err) = create_result {
            let _ = self.delete_iron_proxy_configmap(&id).await;
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
        self.delete_iron_proxy_configmap(id).await
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
    if resolved_iron_proxy.is_some() {
        volume_mounts.push(json!({
            "name": "iron-proxy-certs",
            "mountPath": "/firewall-certs",
            "readOnly": true,
        }));
    }
    insert_optional(
        &mut container,
        "volumeMounts",
        (!volume_mounts.is_empty()).then_some(volume_mounts),
    );
    if let (Some(iron_proxy), Some(_)) = (&config.iron_proxy, resolved_iron_proxy) {
        volumes.extend(iron_proxy_volumes(id, iron_proxy));
    }

    let mut pod_spec = json!({
        "containers": pod_containers(container, config, resolved_iron_proxy),
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
        for (name, value) in proxy_env() {
            env.insert(name, value);
        }
    }
    env.into_iter()
        .map(|(name, value)| json!({ "name": name, "value": value }))
        .collect()
}

fn proxy_env() -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    env.insert("HTTP_PROXY".to_owned(), "http://127.0.0.1:8080".to_owned());
    env.insert("HTTPS_PROXY".to_owned(), "http://127.0.0.1:8080".to_owned());
    env.insert("http_proxy".to_owned(), "http://127.0.0.1:8080".to_owned());
    env.insert("https_proxy".to_owned(), "http://127.0.0.1:8080".to_owned());
    env.insert(
        "NO_PROXY".to_owned(),
        "localhost,127.0.0.1,::1,api".to_owned(),
    );
    env.insert(
        "no_proxy".to_owned(),
        "localhost,127.0.0.1,::1,api".to_owned(),
    );
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

fn spec_env<'a>(spec: &'a SandboxSpec, name: &str) -> Option<&'a str> {
    spec.env
        .iter()
        .find(|item| item.name == name)
        .map(|item| item.value.as_str())
        .filter(|value| !value.trim().is_empty())
}

fn pod_containers(
    agent_container: Value,
    config: &AgentSandboxConfig,
    resolved_iron_proxy: Option<&ResolvedIronProxy>,
) -> Vec<Value> {
    let mut containers = vec![agent_container];
    if let (Some(iron_proxy), Some(_)) = (&config.iron_proxy, resolved_iron_proxy) {
        containers.push(iron_proxy_container(iron_proxy));
    }
    containers
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
            {"containerPort": 9093, "name": "health"}
        ],
        "readinessProbe": {
            "httpGet": {
                "path": "/healthz",
                "port": 9093
            },
            "periodSeconds": 5,
            "failureThreshold": 30
        },
        "livenessProbe": {
            "httpGet": {
                "path": "/healthz",
                "port": 9093
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
        iron_proxy
            .env_from_secret_name
            .as_ref()
            .map(|name| vec![json!({ "secretRef": { "name": name } })]),
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
            "secret": {"secretName": iron_proxy.ca_secret_name}
        }),
    ]
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
    fn builds_agent_sandbox_with_iron_proxy_sidecar_and_placeholder_env() {
        let mut config = AgentSandboxConfig::new("centaur");
        let mut iron_proxy = IronProxyPodConfig::new("centaur-iron-proxy:latest", "firewall-ca");
        iron_proxy.env_from_secret_name = Some("centaur-infra-env".to_owned());
        iron_proxy.extra_env.insert(
            "OP_CONNECT_HOST".to_owned(),
            "http://op-connect:8080".to_owned(),
        );
        config.iron_proxy = Some(iron_proxy);
        let resolved = ResolvedIronProxy {
            config_yaml: "transforms: []\n".to_owned(),
            placeholder_env: BTreeMap::from([(
                "OPENAI_API_KEY".to_owned(),
                "OPENAI_API_KEY".to_owned(),
            )]),
        };
        let spec = SandboxSpec::new("centaur-agent:latest")
            .env("CENTAUR_API_URL", "http://api:8000")
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
        assert_eq!(containers.len(), 2);
        assert_eq!(containers[0].name, "agent");
        assert_eq!(containers[1].name, "iron-proxy");
        assert_eq!(
            containers[1].image.as_deref(),
            Some("centaur-iron-proxy:latest")
        );
        assert_eq!(
            containers[1].env_from.as_ref().unwrap()[0]
                .secret_ref
                .as_ref()
                .unwrap()
                .name
                .as_deref(),
            Some("centaur-infra-env")
        );
        let agent_env = containers[0]
            .env
            .as_ref()
            .unwrap()
            .iter()
            .map(|env| (env.name.as_str(), env.value.as_deref().unwrap_or("")))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(agent_env["OPENAI_API_KEY"], "OPENAI_API_KEY");
        assert_eq!(agent_env["HTTPS_PROXY"], "http://127.0.0.1:8080");
        assert_eq!(
            agent_env["REQUESTS_CA_BUNDLE"],
            "/firewall-certs/ca-cert.pem"
        );
        let volumes = pod_spec.volumes.as_ref().unwrap();
        assert!(
            volumes
                .iter()
                .any(|volume| volume.name == "iron-proxy-config-rendered"
                    && volume.config_map.as_ref().unwrap().name.as_deref()
                        == Some("asbx-test-iron-proxy"))
        );
        assert!(volumes.iter().any(|volume| volume.name == "iron-proxy-ca"
            && volume.secret.as_ref().unwrap().secret_name.as_deref() == Some("firewall-ca")));
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
