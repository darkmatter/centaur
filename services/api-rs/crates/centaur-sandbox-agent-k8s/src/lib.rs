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
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{ConfigMap, PersistentVolumeClaim, Pod, Service};
use k8s_openapi::api::networking::v1::NetworkPolicy;
use kube::api::{
    ApiResource, AttachParams, DeleteParams, DynamicObject, GroupVersionKind, ListParams, Patch,
    PatchParams, PostParams,
};
use kube::{Api, Client, Error};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::{Instant, sleep};
use uuid::Uuid;

pub use generated::agents_x_k8s_io as crd;

pub mod generated;

const BACKEND_NAME: &str = "agent-sandbox-k8s";
const DEFAULT_CONTAINER_NAME: &str = "agent";
const EXTENSIONS_GROUP: &str = "extensions.agents.x-k8s.io";
const DEFAULT_WARM_POOL_API_VERSION: &str = "v1alpha1";
const MANAGED_LABEL: &str = "centaur.ai/managed";
const MANAGED_BY_LABEL: &str = "centaur.ai/managed-by";
const SANDBOX_ID_LABEL: &str = "centaur.ai/sandbox-id";
const SANDBOX_CLAIM_LABEL: &str = "centaur.ai/sandbox-claim";
const SANDBOX_TEMPLATE_LABEL: &str = "centaur.ai/sandbox-template";
const SANDBOX_WARM_POOL_LABEL: &str = "centaur.ai/sandbox-warm-pool";
const MANAGED_BY_VALUE: &str = "api-rs";
const TOKEN_BROKER_LABEL: &str = "centaur.ai/iron-token-broker";
const TOKEN_BROKER_CONFIG_KEY: &str = "iron-token-broker.yaml";
const THREAD_KEY_ENV: &str = "CENTAUR_THREAD_KEY";

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
pub struct AgentSandboxConfig {
    pub namespace: String,
    pub field_manager: String,
    pub container_name: String,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub image_pull_policy: Option<String>,
    pub image_pull_secrets: Vec<String>,
    pub runtime_class_name: Option<String>,
    pub service_account_name: Option<String>,
    pub state_volume: Option<StateVolumeConfig>,
    pub iron_proxy: Option<IronProxyPodConfig>,
    pub warm_pool: Option<SandboxWarmPoolConfig>,
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
            image_pull_secrets: Vec::new(),
            runtime_class_name: None,
            service_account_name: None,
            state_volume: None,
            iron_proxy: None,
            warm_pool: None,
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
    pub image_pull_secrets: Vec<String>,
    pub fragments: Vec<ProxyFragment>,
    pub source_policy: SourcePolicy,
    pub core_pg: Option<CorePgListener>,
    pub harness_auth_modes: BTreeMap<String, String>,
    pub ca_cert_secret_name: String,
    pub ca_key_secret_name: String,
    pub op_connect_app_name: String,
    pub op_connect_port: u16,
    pub api_pod_labels: BTreeMap<String, String>,
    pub token_broker_pod_labels: BTreeMap<String, String>,
    pub env_from_secret_names: Vec<String>,
    pub secret_env_name: Option<String>,
    pub secret_env_prefix: String,
    pub extra_env: BTreeMap<String, String>,
    pub token_broker_name: Option<String>,
    pub token_broker_configmap_name: Option<String>,
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
            image_pull_secrets: Vec::new(),
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
            token_broker_pod_labels: BTreeMap::from([(
                "app.kubernetes.io/component".to_owned(),
                "token-broker".to_owned(),
            )]),
            env_from_secret_names: Vec::new(),
            secret_env_name: None,
            secret_env_prefix: String::new(),
            extra_env: BTreeMap::new(),
            token_broker_name: None,
            token_broker_configmap_name: None,
        }
    }

    pub fn with_fragments(mut self, fragments: Vec<ProxyFragment>) -> Self {
        self.fragments = fragments;
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SandboxWarmPoolConfig {
    pub api_version: String,
    pub pool_name: String,
    pub template_name: String,
    pub replicas: i32,
    pub update_strategy: SandboxWarmPoolUpdateStrategy,
}

impl SandboxWarmPoolConfig {
    pub fn new(pool_name: impl Into<String>, template_name: impl Into<String>) -> Self {
        Self {
            api_version: DEFAULT_WARM_POOL_API_VERSION.to_owned(),
            pool_name: pool_name.into(),
            template_name: template_name.into(),
            replicas: 1,
            update_strategy: SandboxWarmPoolUpdateStrategy::OnReplenish,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxWarmPoolUpdateStrategy {
    OnReplenish,
    Recreate,
}

impl SandboxWarmPoolUpdateStrategy {
    fn as_str(self) -> &'static str {
        match self {
            Self::OnReplenish => "OnReplenish",
            Self::Recreate => "Recreate",
        }
    }
}

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

    fn deployments(&self) -> Api<Deployment> {
        Api::namespaced(self.client.clone(), &self.config.namespace)
    }

    fn sandbox_templates(&self, warm_pool: &SandboxWarmPoolConfig) -> Api<DynamicObject> {
        let resource = extension_resource(
            &warm_pool.api_version,
            "SandboxTemplate",
            "sandboxtemplates",
        );
        Api::namespaced_with(self.client.clone(), &self.config.namespace, &resource)
    }

    fn sandbox_warm_pools(&self, warm_pool: &SandboxWarmPoolConfig) -> Api<DynamicObject> {
        let resource = extension_resource(
            &warm_pool.api_version,
            "SandboxWarmPool",
            "sandboxwarmpools",
        );
        Api::namespaced_with(self.client.clone(), &self.config.namespace, &resource)
    }

    fn sandbox_claims(&self, warm_pool: &SandboxWarmPoolConfig) -> Api<DynamicObject> {
        let resource = extension_resource(&warm_pool.api_version, "SandboxClaim", "sandboxclaims");
        Api::namespaced_with(self.client.clone(), &self.config.namespace, &resource)
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

    async fn reconcile_warm_pool(
        &self,
        spec: &SandboxSpec,
        warm_pool: &SandboxWarmPoolConfig,
    ) -> SandboxResult<()> {
        let template = build_sandbox_template(warm_pool, spec, &self.config)?;
        let pool = build_sandbox_warm_pool(warm_pool);
        let params = PatchParams::apply(&self.config.field_manager).force();
        self.sandbox_templates(warm_pool)
            .patch(&warm_pool.template_name, &params, &Patch::Apply(&template))
            .await
            .map_err(|err| map_kube_error("apply sandbox warm-pool template", err))?;
        self.sandbox_warm_pools(warm_pool)
            .patch(&warm_pool.pool_name, &params, &Patch::Apply(&pool))
            .await
            .map_err(|err| map_kube_error("apply sandbox warm pool", err))?;
        Ok(())
    }

    async fn create_from_warm_pool(
        &self,
        spec: SandboxSpec,
        warm_pool: &SandboxWarmPoolConfig,
    ) -> SandboxResult<SandboxHandle> {
        validate_warm_pool_spec(&spec, &self.config)?;
        self.reconcile_warm_pool(&spec, warm_pool).await?;
        self.wait_for_warm_pool_ready(warm_pool).await?;

        let claim_id = SandboxId::new(next_sandbox_name());
        let claim = build_sandbox_claim(&claim_id, warm_pool, &self.config);
        self.sandbox_claims(warm_pool)
            .create(&PostParams::default(), &claim)
            .await
            .map_err(|err| map_kube_error("create sandbox warm-pool claim", err))?;

        match self.wait_for_sandbox_claim(&claim_id, warm_pool).await {
            Ok(id) => Ok(SandboxHandle::new(id, BACKEND_NAME)),
            Err(err) => {
                let _ = self.delete_sandbox_claim(&claim_id, warm_pool).await;
                Err(err)
            }
        }
    }

    async fn wait_for_warm_pool_ready(
        &self,
        warm_pool: &SandboxWarmPoolConfig,
    ) -> SandboxResult<()> {
        if warm_pool.replicas <= 0 {
            return Ok(());
        }
        let deadline = Instant::now() + self.config.ready_timeout;
        loop {
            let pool = self
                .sandbox_warm_pools(warm_pool)
                .get(&warm_pool.pool_name)
                .await
                .map_err(|err| map_kube_error("get sandbox warm pool", err))?;
            if warm_pool_ready_replicas(&pool) > 0 {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(SandboxError::NotReady(format!(
                    "sandbox warm pool {} did not report ready replicas before timeout",
                    warm_pool.pool_name
                )));
            }
            sleep(Duration::from_millis(250)).await;
        }
    }

    async fn wait_for_sandbox_claim(
        &self,
        claim_id: &SandboxId,
        warm_pool: &SandboxWarmPoolConfig,
    ) -> SandboxResult<SandboxId> {
        let deadline = Instant::now() + self.config.ready_timeout;
        loop {
            let claim = self
                .sandbox_claims(warm_pool)
                .get(claim_id.as_str())
                .await
                .map_err(|err| map_kube_error("get sandbox warm-pool claim", err))?;
            if let Some(name) = claim_sandbox_name(&claim) {
                let id = SandboxId::new(name);
                self.wait_until_running(&id).await?;
                return Ok(id);
            }
            if Instant::now() >= deadline {
                return Err(SandboxError::NotReady(format!(
                    "sandbox warm-pool claim {} was not assigned before timeout",
                    claim_id.as_str()
                )));
            }
            sleep(Duration::from_millis(250)).await;
        }
    }

    async fn delete_sandbox_claim(
        &self,
        claim_id: &SandboxId,
        warm_pool: &SandboxWarmPoolConfig,
    ) -> SandboxResult<()> {
        match self
            .sandbox_claims(warm_pool)
            .delete(claim_id.as_str(), &DeleteParams::default())
            .await
        {
            Ok(_) => Ok(()),
            Err(err) if is_not_found(&err) => Ok(()),
            Err(err) => Err(map_kube_error("delete sandbox warm-pool claim", err)),
        }
    }

    async fn delete_warm_pool_claim_for_sandbox(&self, id: &SandboxId) -> SandboxResult<()> {
        let Some(warm_pool) = &self.config.warm_pool else {
            return Ok(());
        };
        let Some(sandbox) = self.get_sandbox(id).await? else {
            return Ok(());
        };
        for claim_name in sandbox_claim_owner_names(&sandbox) {
            self.delete_sandbox_claim(&SandboxId::new(claim_name), warm_pool)
                .await?;
        }
        Ok(())
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
        let config_hash = short_sha256(&rendered);
        let changed = self
            .apply_token_broker_configmap(iron_proxy, &rendered)
            .await?;
        if changed {
            self.patch_token_broker_config_hash(token_broker_name, &config_hash)
                .await?;
        }
        Ok(())
    }

    async fn apply_token_broker_configmap(
        &self,
        iron_proxy: &IronProxyPodConfig,
        rendered: &str,
    ) -> SandboxResult<bool> {
        let configmap_name = iron_token_broker_configmap_name(iron_proxy)?;
        let mut data = BTreeMap::new();
        data.insert(TOKEN_BROKER_CONFIG_KEY.to_owned(), rendered.to_owned());
        match self.config_maps().get(&configmap_name).await {
            Ok(existing) => {
                let existing_data = existing
                    .data
                    .as_ref()
                    .and_then(|data| data.get(TOKEN_BROKER_CONFIG_KEY));
                if existing_data.is_some_and(|value| value == rendered) {
                    return Ok(false);
                }
                let patch = Patch::Merge(json!({
                    "metadata": {"labels": token_broker_labels()},
                    "data": data,
                }));
                self.config_maps()
                    .patch(&configmap_name, &PatchParams::default(), &patch)
                    .await
                    .map(|_| true)
                    .map_err(|err| map_kube_error("patch iron-token-broker configmap", err))
            }
            Err(err) if is_not_found(&err) => {
                let body = ConfigMap {
                    metadata: k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta {
                        name: Some(configmap_name),
                        labels: Some(token_broker_labels()),
                        ..Default::default()
                    },
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
        let pod = build_iron_proxy_pod(id, &resolved.proxy_pod_name, iron_proxy, resolved)?;
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
        if let Some(warm_pool) = &self.config.warm_pool {
            return self.create_from_warm_pool(spec, warm_pool).await;
        }

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
        self.delete_warm_pool_claim_for_sandbox(id).await?;
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

fn extension_resource(api_version: &str, kind: &str, plural: &str) -> ApiResource {
    ApiResource::from_gvk_with_plural(
        &GroupVersionKind::gvk(EXTENSIONS_GROUP, api_version, kind),
        plural,
    )
}

fn validate_warm_pool_spec(spec: &SandboxSpec, config: &AgentSandboxConfig) -> SandboxResult<()> {
    if config.iron_proxy.is_some() {
        return Err(SandboxError::InvalidSpec(
            "SandboxWarmPool mode cannot be combined with per-sandbox iron-proxy resources"
                .to_owned(),
        ));
    }
    if spec_env(spec, THREAD_KEY_ENV).is_some() {
        return Err(SandboxError::InvalidSpec(format!(
            "SandboxWarmPool templates cannot include per-thread {THREAD_KEY_ENV}; pass thread context with each turn instead"
        )));
    }
    Ok(())
}

fn build_sandbox_template(
    warm_pool: &SandboxWarmPoolConfig,
    spec: &SandboxSpec,
    config: &AgentSandboxConfig,
) -> SandboxResult<DynamicObject> {
    let template_id = SandboxId::new(warm_pool.template_name.clone());
    let sandbox = build_agent_sandbox(&template_id, spec, config, None)?;
    let mut template_spec = serde_json::to_value(&sandbox.spec).map_err(|err| {
        SandboxError::InvalidSpec(format!("invalid sandbox warm-pool template: {err}"))
    })?;
    let spec_object = template_spec.as_object_mut().ok_or_else(|| {
        SandboxError::InvalidSpec("sandbox warm-pool template spec must be an object".to_owned())
    })?;
    spec_object.remove("replicas");
    spec_object.remove("shutdownPolicy");
    spec_object.remove("shutdownTime");
    if let Some(labels) = spec_object
        .get_mut("podTemplate")
        .and_then(|pod_template| pod_template.get_mut("metadata"))
        .and_then(|metadata| metadata.get_mut("labels"))
        .and_then(Value::as_object_mut)
    {
        labels.remove(SANDBOX_ID_LABEL);
    }

    let mut template = DynamicObject::new(
        &warm_pool.template_name,
        &extension_resource(
            &warm_pool.api_version,
            "SandboxTemplate",
            "sandboxtemplates",
        ),
    )
    .data(json!({ "spec": template_spec }));
    template.metadata.labels = Some(warm_pool_labels(warm_pool));
    template.metadata.annotations = Some(config.annotations.clone());
    Ok(template)
}

fn build_sandbox_warm_pool(warm_pool: &SandboxWarmPoolConfig) -> DynamicObject {
    let mut pool = DynamicObject::new(
        &warm_pool.pool_name,
        &extension_resource(
            &warm_pool.api_version,
            "SandboxWarmPool",
            "sandboxwarmpools",
        ),
    )
    .data(json!({
        "spec": {
            "replicas": warm_pool.replicas,
            "sandboxTemplateRef": {
                "name": warm_pool.template_name,
            },
            "updateStrategy": {
                "type": warm_pool.update_strategy.as_str(),
            },
        },
    }));
    pool.metadata.labels = Some(warm_pool_labels(warm_pool));
    pool
}

fn build_sandbox_claim(
    claim_id: &SandboxId,
    warm_pool: &SandboxWarmPoolConfig,
    config: &AgentSandboxConfig,
) -> DynamicObject {
    let mut claim = DynamicObject::new(
        claim_id.as_str(),
        &extension_resource(&warm_pool.api_version, "SandboxClaim", "sandboxclaims"),
    )
    .data(json!({
        "spec": {
            "sandboxTemplateRef": {
                "name": warm_pool.template_name,
            },
            "warmpool": warm_pool.pool_name,
            "additionalPodMetadata": {
                "labels": claimed_sandbox_labels(claim_id, warm_pool),
                "annotations": config.annotations.clone(),
            },
        },
    }));
    claim.metadata.labels = Some(claim_labels(claim_id, warm_pool));
    claim.metadata.annotations = Some(config.annotations.clone());
    claim
}

fn claim_sandbox_name(claim: &DynamicObject) -> Option<String> {
    claim
        .data
        .pointer("/status/sandbox/name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
}

fn warm_pool_ready_replicas(pool: &DynamicObject) -> i64 {
    pool.data
        .pointer("/status/readyReplicas")
        .and_then(Value::as_i64)
        .unwrap_or_default()
}

fn sandbox_claim_owner_names(sandbox: &crd::Sandbox) -> Vec<String> {
    sandbox
        .metadata
        .owner_references
        .as_ref()
        .into_iter()
        .flatten()
        .filter(|owner| {
            owner.kind == "SandboxClaim"
                && owner
                    .api_version
                    .starts_with(&format!("{EXTENSIONS_GROUP}/"))
        })
        .map(|owner| owner.name.clone())
        .collect()
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
        "imagePullSecrets",
        image_pull_secret_refs(&config.image_pull_secrets),
    );
    insert_optional(
        &mut pod_spec,
        "runtimeClassName",
        config.runtime_class_name.clone(),
    );
    insert_optional(
        &mut pod_spec,
        "serviceAccountName",
        config.service_account_name.clone(),
    );
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
    env.into_iter()
        .map(|(name, value)| json!({ "name": name, "value": value }))
        .collect()
}

fn proxy_env(
    proxy_host: &str,
    proxy_port: u16,
    api_host: Option<&str>,
    no_proxy_extra: &[&str],
) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    let proxy_url = format!("http://{proxy_host}:{proxy_port}");
    let no_proxy = no_proxy_value(proxy_host, api_host, no_proxy_extra);
    env.insert("FIREWALL_HOST".to_owned(), proxy_host.to_owned());
    env.insert("FIREWALL_PROXY_PORT".to_owned(), proxy_port.to_string());
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
        "CURL_CA_BUNDLE".to_owned(),
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

fn spec_env<'a>(spec: &'a SandboxSpec, name: &str) -> Option<&'a str> {
    spec.env
        .iter()
        .rev()
        .find(|item| item.name == name)
        .map(|item| item.value.as_str())
        .filter(|value| !value.trim().is_empty())
}

fn iron_proxy_container(iron_proxy: &IronProxyPodConfig, resolved: &ResolvedIronProxy) -> Value {
    let mut env = BTreeMap::<String, Value>::new();
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
        if iron_proxy.extra_env.contains_key("IRON_BROKER_URL") {
            insert_env_secret_ref(
                &mut env,
                "IRON_BROKER_TOKEN",
                secret_name,
                &iron_proxy.secret_env_prefix,
            );
        }
    }
    let mut container_ports = vec![
        json!({"containerPort": resolved.proxy_port, "name": "proxy"}),
        json!({"containerPort": 9092, "name": "management"}),
        json!({"containerPort": 9090, "name": "health"}),
    ];
    for port in resolved
        .listen_ports
        .iter()
        .copied()
        .filter(|port| ![resolved.proxy_port, 9092, 9090].contains(port))
    {
        container_ports.push(json!({"containerPort": port, "name": format!("tcp-{port}")}));
    }

    let mut container = json!({
        "name": "iron-proxy",
        "image": iron_proxy.image,
        "env": env.into_values().collect::<Vec<_>>(),
        "ports": container_ports,
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

fn insert_env_value(env: &mut BTreeMap<String, Value>, name: &str, value: impl AsRef<str>) {
    env.insert(
        name.to_owned(),
        json!({"name": name, "value": value.as_ref()}),
    );
}

fn insert_env_secret_ref(
    env: &mut BTreeMap<String, Value>,
    name: &str,
    secret_name: &str,
    secret_prefix: &str,
) {
    env.insert(
        name.to_owned(),
        json!({
            "name": name,
            "valueFrom": {
                "secretKeyRef": {
                    "name": secret_name,
                    "key": format!("{secret_prefix}{name}"),
                }
            }
        }),
    );
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
    resolved: &ResolvedIronProxy,
) -> SandboxResult<Pod> {
    let labels = iron_proxy_labels(id);
    let mut pod_spec = json!({
        "automountServiceAccountToken": false,
        "restartPolicy": "Never",
        "containers": [iron_proxy_container(iron_proxy, resolved)],
        "volumes": iron_proxy_volumes(id, iron_proxy),
    });
    insert_optional(
        &mut pod_spec,
        "imagePullSecrets",
        image_pull_secret_refs(&iron_proxy.image_pull_secrets),
    );
    let pod = json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": pod_name,
            "labels": labels,
        },
        "spec": pod_spec,
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
        "port": resolved.proxy_port,
        "targetPort": resolved.proxy_port,
        "protocol": "TCP",
    })];
    for port in resolved
        .listen_ports
        .iter()
        .copied()
        .filter(|port| *port != resolved.proxy_port)
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
    let mut sandbox_to_proxy_ports = vec![json!({"protocol": "TCP", "port": resolved.proxy_port})];
    for port in resolved
        .listen_ports
        .iter()
        .copied()
        .filter(|port| *port != resolved.proxy_port)
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
                dns_egress_rule(),
            ],
        },
    });
    let mut proxy_egress = vec![
        dns_egress_rule(),
        json!({
            "to": [{"podSelector": {"matchLabels": iron_proxy.api_pod_labels.clone()}}],
            "ports": [{"protocol": "TCP", "port": 8000}],
        }),
        json!({
            "ports": [
                {"protocol": "TCP", "port": 443},
                {"protocol": "TCP", "port": 5432},
            ],
        }),
    ];
    if let Some(broker_port) = iron_proxy_broker_port(iron_proxy) {
        if iron_proxy.token_broker_name.is_some() {
            proxy_egress.push(json!({
                "to": [{"podSelector": {"matchLabels": iron_proxy.token_broker_pod_labels.clone()}}],
                "ports": [{"protocol": "TCP", "port": broker_port}],
            }));
        } else {
            proxy_egress.push(json!({
                "ports": [{"protocol": "TCP", "port": broker_port}],
            }));
        }
    }
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

fn dns_egress_rule() -> Value {
    json!({
        "to": [{
            "namespaceSelector": {
                "matchLabels": {"kubernetes.io/metadata.name": "kube-system"},
            },
        }],
        "ports": [
            {"protocol": "UDP", "port": 53},
            {"protocol": "TCP", "port": 53},
        ],
    })
}

fn iron_proxy_broker_port(iron_proxy: &IronProxyPodConfig) -> Option<u16> {
    iron_proxy
        .extra_env
        .get("IRON_BROKER_URL")
        .map(|url| url_port(url).unwrap_or(centaur_iron_proxy::DEFAULT_BROKER_LISTEN_PORT))
        .or_else(|| {
            iron_proxy
                .token_broker_name
                .as_ref()
                .map(|_| centaur_iron_proxy::DEFAULT_BROKER_LISTEN_PORT)
        })
}

fn url_port(value: &str) -> Option<u16> {
    let without_scheme = value
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(value);
    let authority = without_scheme.split('/').next()?.trim();
    authority.rsplit_once(':')?.1.parse().ok()
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

fn token_broker_labels() -> BTreeMap<String, String> {
    BTreeMap::from([
        (TOKEN_BROKER_LABEL.to_owned(), "true".to_owned()),
        (
            "app.kubernetes.io/component".to_owned(),
            "token-broker".to_owned(),
        ),
    ])
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

fn warm_pool_labels(warm_pool: &SandboxWarmPoolConfig) -> BTreeMap<String, String> {
    BTreeMap::from([
        (MANAGED_LABEL.to_owned(), "true".to_owned()),
        (MANAGED_BY_LABEL.to_owned(), MANAGED_BY_VALUE.to_owned()),
        (
            SANDBOX_WARM_POOL_LABEL.to_owned(),
            warm_pool.pool_name.clone(),
        ),
        (
            SANDBOX_TEMPLATE_LABEL.to_owned(),
            warm_pool.template_name.clone(),
        ),
    ])
}

fn claim_labels(
    claim_id: &SandboxId,
    warm_pool: &SandboxWarmPoolConfig,
) -> BTreeMap<String, String> {
    let mut labels = sandbox_labels(claim_id);
    labels.insert(
        SANDBOX_WARM_POOL_LABEL.to_owned(),
        warm_pool.pool_name.clone(),
    );
    labels.insert(
        SANDBOX_TEMPLATE_LABEL.to_owned(),
        warm_pool.template_name.clone(),
    );
    labels.insert(SANDBOX_CLAIM_LABEL.to_owned(), claim_id.as_str().to_owned());
    labels
}

fn claimed_sandbox_labels(
    claim_id: &SandboxId,
    warm_pool: &SandboxWarmPoolConfig,
) -> BTreeMap<String, String> {
    let mut labels = claim_labels(claim_id, warm_pool);
    labels.remove(SANDBOX_ID_LABEL);
    labels
}

fn insert_optional<T>(target: &mut Value, key: &str, value: Option<T>)
where
    T: serde::Serialize,
{
    if let Some(value) = value {
        target[key] = json!(value);
    }
}

fn image_pull_secret_refs(names: &[String]) -> Option<Vec<Value>> {
    (!names.is_empty()).then(|| {
        names
            .iter()
            .map(|name| json!({ "name": name }))
            .collect::<Vec<_>>()
    })
}

fn short_sha256(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    format!("{digest:x}").chars().take(16).collect()
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
    use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;

    use super::*;

    fn env_values(env: &[crd::SandboxPodTemplateSpecContainersEnv]) -> BTreeMap<&str, &str> {
        env.iter()
            .filter_map(|item| {
                item.value
                    .as_deref()
                    .map(|value| (item.name.as_str(), value))
            })
            .collect()
    }

    fn policy_json_by_name(policies: &[NetworkPolicy]) -> BTreeMap<String, Value> {
        policies
            .iter()
            .map(|policy| {
                (
                    policy.metadata.name.as_deref().unwrap().to_owned(),
                    serde_json::to_value(policy).unwrap(),
                )
            })
            .collect()
    }

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
        let mut config = AgentSandboxConfig::new("centaur")
            .state_volume(StateVolumeConfig::new("/home/agent/state", "10Gi"));
        config.image_pull_secrets = vec!["regcred".to_owned(), "mirrorcred".to_owned()];
        config.runtime_class_name = Some("gvisor".to_owned());
        config.service_account_name = Some("sandbox-agent".to_owned());

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
        let pod_spec = &sandbox.spec.pod_template.spec;
        assert_eq!(pod_spec.runtime_class_name.as_deref(), Some("gvisor"));
        assert_eq!(
            pod_spec.service_account_name.as_deref(),
            Some("sandbox-agent")
        );
        let image_pull_secrets = pod_spec.image_pull_secrets.as_ref().unwrap();
        assert_eq!(image_pull_secrets[0].name.as_deref(), Some("regcred"));
        assert_eq!(image_pull_secrets[1].name.as_deref(), Some("mirrorcred"));
    }

    #[test]
    fn builds_sandbox_warm_pool_extension_objects() {
        let mut warm_pool = SandboxWarmPoolConfig::new("centaur-warm", "centaur-warm-template");
        warm_pool.replicas = 3;
        warm_pool.update_strategy = SandboxWarmPoolUpdateStrategy::Recreate;
        let spec = SandboxSpec::new("centaur-agent:latest")
            .env("CENTAUR_API_URL", "http://api:8000")
            .resources(ResourceLimits::new().memory_bytes(1024 * 1024 * 1024));
        let mut config = AgentSandboxConfig::new("centaur")
            .state_volume(StateVolumeConfig::new("/home/agent/state", "10Gi"));
        config
            .annotations
            .insert("centaur.ai/test".to_owned(), "true".to_owned());

        let template = build_sandbox_template(&warm_pool, &spec, &config).unwrap();
        let pool = build_sandbox_warm_pool(&warm_pool);

        let template_types = template.types.as_ref().unwrap();
        assert_eq!(
            template_types.api_version,
            "extensions.agents.x-k8s.io/v1alpha1"
        );
        assert_eq!(template_types.kind, "SandboxTemplate");
        assert_eq!(
            template.metadata.labels.as_ref().unwrap()[SANDBOX_WARM_POOL_LABEL],
            "centaur-warm"
        );
        assert_eq!(
            template.metadata.annotations.as_ref().unwrap()["centaur.ai/test"],
            "true"
        );
        assert!(template.data["spec"].get("replicas").is_none());
        assert!(template.data["spec"].get("shutdownPolicy").is_none());
        assert_eq!(
            template.data["spec"]["podTemplate"]["spec"]["containers"][0]["image"],
            "centaur-agent:latest"
        );
        assert!(
            template.data["spec"]["podTemplate"]["metadata"]["labels"]
                .get(SANDBOX_ID_LABEL)
                .is_none()
        );
        assert_eq!(
            template.data["spec"]["volumeClaimTemplates"][0]["metadata"]["name"],
            "state"
        );

        let pool_types = pool.types.as_ref().unwrap();
        assert_eq!(pool_types.kind, "SandboxWarmPool");
        assert_eq!(pool.data["spec"]["replicas"], 3);
        assert_eq!(
            pool.data["spec"]["sandboxTemplateRef"]["name"],
            "centaur-warm-template"
        );
        assert_eq!(pool.data["spec"]["updateStrategy"]["type"], "Recreate");
    }

    #[test]
    fn builds_sandbox_claim_without_env_so_pool_adoption_stays_warm() {
        let warm_pool = SandboxWarmPoolConfig::new("centaur-warm", "centaur-template");
        let config = AgentSandboxConfig::new("centaur");

        let claim = build_sandbox_claim(&SandboxId::new("asbx-claim"), &warm_pool, &config);

        let claim_types = claim.types.as_ref().unwrap();
        assert_eq!(claim_types.kind, "SandboxClaim");
        assert_eq!(
            claim.data["spec"]["sandboxTemplateRef"]["name"],
            "centaur-template"
        );
        assert_eq!(claim.data["spec"]["warmpool"], "centaur-warm");
        assert!(claim.data["spec"].get("env").is_none());
        assert_eq!(
            claim.data["spec"]["additionalPodMetadata"]["labels"][SANDBOX_CLAIM_LABEL],
            "asbx-claim"
        );
    }

    #[test]
    fn reads_sandbox_warm_pool_ready_replicas() {
        let warm_pool = SandboxWarmPoolConfig::new("centaur-warm", "centaur-template");
        let mut pool = build_sandbox_warm_pool(&warm_pool);

        assert_eq!(warm_pool_ready_replicas(&pool), 0);

        pool.data["status"] = json!({"readyReplicas": 2});

        assert_eq!(warm_pool_ready_replicas(&pool), 2);
    }

    #[test]
    fn warm_pool_validation_rejects_cold_starting_inputs() {
        let mut config = AgentSandboxConfig::new("centaur");
        let spec = SandboxSpec::new("centaur-agent:latest").env(THREAD_KEY_ENV, "test:thread");

        let error = validate_warm_pool_spec(&spec, &config).unwrap_err();
        assert!(error.to_string().contains(THREAD_KEY_ENV));

        config.iron_proxy = Some(IronProxyPodConfig::new(
            "centaur-iron-proxy:latest",
            "firewall-ca-cert",
            "firewall-ca-key",
        ));
        let error = validate_warm_pool_spec(&SandboxSpec::new("centaur-agent:latest"), &config)
            .unwrap_err();
        assert!(error.to_string().contains("iron-proxy"));
    }

    #[test]
    fn extracts_sandbox_claim_owner_names() {
        let mut sandbox = build_agent_sandbox(
            &SandboxId::new("asbx-adopted"),
            &SandboxSpec::new("centaur-agent:latest"),
            &AgentSandboxConfig::new("centaur"),
            None,
        )
        .unwrap();
        sandbox.metadata.owner_references = Some(vec![
            k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference {
                api_version: "extensions.agents.x-k8s.io/v1beta1".to_owned(),
                kind: "SandboxClaim".to_owned(),
                name: "asbx-claim".to_owned(),
                uid: "uid-1".to_owned(),
                block_owner_deletion: None,
                controller: None,
            },
        ]);

        assert_eq!(sandbox_claim_owner_names(&sandbox), ["asbx-claim"]);
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
            proxy_port: 18080,
            listen_ports: vec![8080],
            pg_dsn_env: BTreeMap::from([(
                "WAREHOUSE_DSN".to_owned(),
                "postgresql://app_user:pg-pass@asbx-test-proxy:5432/warehouse".to_owned(),
            )]),
            pg_proxy_password_env: BTreeMap::new(),
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
        assert_eq!(
            agent_env["WAREHOUSE_DSN"],
            "postgresql://app_user:pg-pass@asbx-test-proxy:5432/warehouse"
        );
        assert_eq!(agent_env["FIREWALL_HOST"], "asbx-test-proxy");
        assert_eq!(agent_env["FIREWALL_PROXY_PORT"], "18080");
        assert_eq!(agent_env["HTTPS_PROXY"], "http://asbx-test-proxy:18080");
        assert!(agent_env["NO_PROXY"].contains("asbx-test-proxy"));
        assert!(agent_env["NO_PROXY"].contains("centaur-centaur-api"));
        assert!(agent_env["NO_PROXY"].contains("otel.local"));
        assert_eq!(
            agent_env["REQUESTS_CA_BUNDLE"],
            "/firewall-certs/ca-cert.pem"
        );
        assert_eq!(agent_env["CURL_CA_BUNDLE"], "/firewall-certs/ca-cert.pem");
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
    fn security_model_agent_pod_gets_placeholders_not_proxy_secrets() {
        let mut iron_proxy = IronProxyPodConfig::new(
            "centaur-iron-proxy:latest",
            "firewall-ca-cert",
            "firewall-ca-key",
        );
        iron_proxy.source_policy = SourcePolicy::onepassword_connect("ai-agents", "10m");
        iron_proxy.secret_env_name = Some("centaur-infra-env".to_owned());
        iron_proxy.secret_env_prefix = "CENT_".to_owned();
        iron_proxy.extra_env.insert(
            "IRON_BROKER_URL".to_owned(),
            "http://token-broker:8181".to_owned(),
        );
        let mut config = AgentSandboxConfig::new("centaur");
        config.iron_proxy = Some(iron_proxy);
        let resolved = ResolvedIronProxy {
            config_yaml: "transforms: []\n".to_owned(),
            placeholder_env: BTreeMap::from([
                ("OPENAI_API_KEY".to_owned(), "OPENAI_API_KEY".to_owned()),
                ("GITHUB_TOKEN".to_owned(), "GITHUB_TOKEN".to_owned()),
            ]),
            proxy_host: "asbx-sec-proxy".to_owned(),
            proxy_pod_name: "asbx-sec-proxy-123".to_owned(),
            proxy_port: 18080,
            listen_ports: vec![18080],
            pg_dsn_env: BTreeMap::from([(
                "WAREHOUSE_DSN".to_owned(),
                "postgresql://app_user:pg-pass@asbx-sec-proxy:5440/warehouse".to_owned(),
            )]),
            pg_proxy_password_env: BTreeMap::from([(
                "PG_PROXY_PASSWORD_WAREHOUSE".to_owned(),
                "pg-pass".to_owned(),
            )]),
        };
        let spec = SandboxSpec::new("centaur-agent:latest")
            .env("CENTAUR_API_URL", "http://api:8000")
            .env("CENTAUR_API_KEY", "sbx1.placeholder")
            .env("CENTAUR_HARNESS_KIND", "codex");

        let sandbox =
            build_agent_sandbox(&SandboxId::new("asbx-sec"), &spec, &config, Some(&resolved))
                .unwrap();
        let pod_spec = &sandbox.spec.pod_template.spec;
        assert_eq!(pod_spec.automount_service_account_token, Some(false));
        let container = &pod_spec.containers[0];
        let env = env_values(container.env.as_ref().unwrap());

        assert_eq!(env["OPENAI_API_KEY"], "OPENAI_API_KEY");
        assert_eq!(env["GITHUB_TOKEN"], "GITHUB_TOKEN");
        assert_eq!(
            env["WAREHOUSE_DSN"],
            "postgresql://app_user:pg-pass@asbx-sec-proxy:5440/warehouse"
        );
        assert_eq!(env["HTTPS_PROXY"], "http://asbx-sec-proxy:18080");
        assert_eq!(env["HTTP_PROXY"], "http://asbx-sec-proxy:18080");

        for proxy_only_name in [
            "IRON_MANAGEMENT_API_KEY",
            "OP_CONNECT_TOKEN",
            "IRON_BROKER_TOKEN",
            "PG_PROXY_PASSWORD_WAREHOUSE",
        ] {
            assert!(
                !env.contains_key(proxy_only_name),
                "{proxy_only_name} must stay out of the untrusted agent pod"
            );
        }

        let volumes = pod_spec.volumes.as_ref().unwrap();
        assert!(volumes.iter().any(|volume| {
            volume.name == "iron-proxy-ca-cert"
                && volume.secret.as_ref().unwrap().secret_name.as_deref()
                    == Some("firewall-ca-cert")
        }));
        assert!(
            !volumes.iter().any(|volume| volume.name == "iron-proxy-ca"),
            "agent pod must not mount the proxy CA private key"
        );
        assert!(
            !volumes
                .iter()
                .any(|volume| volume.name == "iron-proxy-config-rendered"),
            "agent pod must not mount the rendered proxy policy"
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
        iron_proxy.image_pull_secrets = vec!["regcred".to_owned()];
        iron_proxy.source_policy = SourcePolicy::onepassword_connect("ai-agents", "10m");
        iron_proxy
            .env_from_secret_names
            .push("centaur-infra-env".to_owned());
        iron_proxy.secret_env_name = Some("centaur-infra-env".to_owned());
        iron_proxy.secret_env_prefix = "CENT_".to_owned();
        iron_proxy.token_broker_name = Some("centaur-token-broker".to_owned());
        iron_proxy.extra_env.insert(
            "OP_CONNECT_HOST".to_owned(),
            "http://op-connect:8080".to_owned(),
        );
        iron_proxy.extra_env.insert(
            "IRON_BROKER_URL".to_owned(),
            "http://token-broker:8181".to_owned(),
        );
        let resolved = ResolvedIronProxy {
            config_yaml: "transforms: []\n".to_owned(),
            placeholder_env: BTreeMap::new(),
            proxy_host: "asbx-test-proxy".to_owned(),
            proxy_pod_name: "asbx-test-proxy-123".to_owned(),
            proxy_port: 18080,
            listen_ports: vec![5432, 8080, 18080],
            pg_dsn_env: BTreeMap::new(),
            pg_proxy_password_env: BTreeMap::from([(
                "PG_PROXY_PASSWORD_WAREHOUSE".to_owned(),
                "pg-pass".to_owned(),
            )]),
        };

        let pod =
            build_iron_proxy_pod(&id, &resolved.proxy_pod_name, &iron_proxy, &resolved).unwrap();
        assert_eq!(pod.metadata.name.as_deref(), Some("asbx-test-proxy-123"));
        assert_eq!(
            pod.spec
                .as_ref()
                .unwrap()
                .image_pull_secrets
                .as_ref()
                .unwrap()[0]
                .name
                .as_str(),
            "regcred"
        );
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
        let container_ports = container
            .ports
            .as_ref()
            .unwrap()
            .iter()
            .map(|port| (port.name.as_deref().unwrap_or(""), port.container_port))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(container_ports["proxy"], 18080);
        assert_eq!(container_ports["tcp-5432"], 5432);
        assert_eq!(container_ports["tcp-8080"], 8080);
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
        let env = container
            .env
            .as_ref()
            .unwrap()
            .iter()
            .map(|item| (item.name.as_str(), item))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            env["IRON_MANAGEMENT_API_KEY"]
                .value_from
                .as_ref()
                .unwrap()
                .secret_key_ref
                .as_ref()
                .unwrap()
                .key,
            "CENT_IRON_MANAGEMENT_API_KEY"
        );
        assert_eq!(
            env["OP_CONNECT_TOKEN"]
                .value_from
                .as_ref()
                .unwrap()
                .secret_key_ref
                .as_ref()
                .unwrap()
                .key,
            "CENT_OP_CONNECT_TOKEN"
        );
        assert_eq!(
            env["IRON_BROKER_TOKEN"]
                .value_from
                .as_ref()
                .unwrap()
                .secret_key_ref
                .as_ref()
                .unwrap()
                .key,
            "CENT_IRON_BROKER_TOKEN"
        );
        assert_eq!(
            env["IRON_BROKER_URL"].value.as_deref(),
            Some("http://token-broker:8181")
        );
        assert_eq!(
            env["PG_PROXY_PASSWORD_WAREHOUSE"].value.as_deref(),
            Some("pg-pass")
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
        assert_eq!(service_ports["proxy"], 18080);
        assert_eq!(service_ports["tcp-8080"], 8080);
        assert_eq!(service_ports["tcp-5432"], 5432);

        let policies = build_iron_proxy_network_policies(&id, &resolved, &iron_proxy).unwrap();
        assert_eq!(policies.len(), 2);
        let policy_json = policy_json_by_name(&policies);
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
            policy_json["asbx-test-sandbox-egress"]["spec"]["egress"]
                .as_array()
                .unwrap()
                .iter()
                .any(|rule| rule["to"][0]["namespaceSelector"]["matchLabels"]
                    ["kubernetes.io/metadata.name"]
                    == "kube-system"
                    && rule["ports"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|port| port["port"] == 53))
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
        assert!(
            policy_json["asbx-test-proxy-net"]["spec"]["egress"]
                .as_array()
                .unwrap()
                .iter()
                .any(|rule| rule["to"][0]["podSelector"]["matchLabels"]
                    ["app.kubernetes.io/component"]
                    == "token-broker"
                    && rule["ports"][0]["port"] == 8181)
        );
    }

    #[test]
    fn security_model_sandbox_egress_is_limited_to_proxy_api_and_dns() {
        let id = SandboxId::new("asbx-sec");
        let mut iron_proxy = IronProxyPodConfig::new(
            "centaur-iron-proxy:latest",
            "firewall-ca-cert",
            "firewall-ca-key",
        );
        iron_proxy.api_pod_labels = BTreeMap::from([("app".to_owned(), "centaur-api".to_owned())]);
        iron_proxy.token_broker_name = Some("centaur-token-broker".to_owned());
        let resolved = ResolvedIronProxy {
            config_yaml: "transforms: []\n".to_owned(),
            placeholder_env: BTreeMap::new(),
            proxy_host: "asbx-sec-proxy".to_owned(),
            proxy_pod_name: "asbx-sec-proxy-123".to_owned(),
            proxy_port: 18080,
            listen_ports: vec![18080, 5440],
            pg_dsn_env: BTreeMap::new(),
            pg_proxy_password_env: BTreeMap::new(),
        };

        let policies = build_iron_proxy_network_policies(&id, &resolved, &iron_proxy).unwrap();
        let policy_json = policy_json_by_name(&policies);
        let sandbox_egress = policy_json["asbx-sec-sandbox-egress"]["spec"]["egress"]
            .as_array()
            .unwrap();
        assert_eq!(sandbox_egress.len(), 3);

        assert!(sandbox_egress.iter().any(|rule| {
            rule["to"][0]["podSelector"]["matchLabels"]["centaur.ai/iron-proxy"] == "true"
                && rule["to"][0]["podSelector"]["matchLabels"][SANDBOX_ID_LABEL] == "asbx-sec"
                && rule["ports"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|port| port["port"] == 18080)
                && rule["ports"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|port| port["port"] == 5440)
        }));
        assert!(sandbox_egress.iter().any(|rule| {
            rule["to"][0]["podSelector"]["matchLabels"]["app"] == "centaur-api"
                && rule["ports"][0]["port"] == 8000
        }));
        assert!(sandbox_egress.iter().any(|rule| {
            rule["to"][0]["namespaceSelector"]["matchLabels"]["kubernetes.io/metadata.name"]
                == "kube-system"
                && rule["ports"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|port| port["port"] == 53)
        }));
        assert!(
            sandbox_egress.iter().all(|rule| rule.get("to").is_some()),
            "sandbox egress must not contain broad IP rules"
        );
        assert!(
            sandbox_egress.iter().all(|rule| {
                !rule["ports"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|port| port["port"] == 443 || port["port"] == 5432)
            }),
            "direct external HTTPS/Postgres egress belongs only on the proxy policy"
        );

        let proxy_policy = &policy_json["asbx-sec-proxy-net"];
        let proxy_ingress = proxy_policy["spec"]["ingress"].as_array().unwrap();
        assert_eq!(proxy_ingress.len(), 1);
        assert_eq!(
            proxy_ingress[0]["from"][0]["podSelector"]["matchLabels"][SANDBOX_ID_LABEL],
            "asbx-sec"
        );
        assert_eq!(
            proxy_ingress[0]["from"][0]["podSelector"]["matchLabels"][MANAGED_LABEL],
            "true"
        );
        let proxy_egress = proxy_policy["spec"]["egress"].as_array().unwrap();
        assert!(proxy_egress.iter().any(|rule| {
            rule["ports"]
                .as_array()
                .unwrap()
                .iter()
                .any(|port| port["port"] == 443)
        }));
        assert!(proxy_egress.iter().any(|rule| {
            rule["to"][0]["podSelector"]["matchLabels"]["app.kubernetes.io/component"]
                == "token-broker"
                && rule["ports"][0]["port"] == 8181
        }));
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

    #[test]
    fn token_broker_configmap_defaults_to_deployment_name() {
        let mut iron_proxy = IronProxyPodConfig::new(
            "centaur-iron-proxy:latest",
            "firewall-ca-cert",
            "firewall-ca-key",
        );
        iron_proxy.token_broker_name = Some("centaur-token-broker".to_owned());
        assert_eq!(
            iron_token_broker_configmap_name(&iron_proxy).unwrap(),
            "centaur-token-broker-config"
        );
        iron_proxy.token_broker_configmap_name = Some("custom-config".to_owned());
        assert_eq!(
            iron_token_broker_configmap_name(&iron_proxy).unwrap(),
            "custom-config"
        );
        let labels = token_broker_labels();
        assert_eq!(labels[TOKEN_BROKER_LABEL], "true");
        assert_eq!(short_sha256("abc"), "ba7816bf8f01cfea");
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
