use std::collections::BTreeMap;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{Method, StatusCode, Uri};
use axum::{Json, Router};
use centaur_sandbox_core::SandboxBackend;
use tokio::sync::{Mutex, Notify};

#[derive(Default)]
struct FenceGate {
    entered: Notify,
    release: Notify,
}

use super::*;
use crate::{
    AgentSandboxConfig, StateVolumeConfig, build_agent_sandbox, test_iron_control_settings,
};

const SANDBOXES: &str = "/apis/agents.x-k8s.io/v1alpha1/namespaces/test/sandboxes";
const PODS: &str = "/api/v1/namespaces/test/pods";
const SERVICES: &str = "/api/v1/namespaces/test/services";
const POLICIES: &str = "/apis/networking.k8s.io/v1/namespaces/test/networkpolicies";
const GRACE: Duration = Duration::from_secs(600);

#[derive(Default)]
struct Cluster {
    resources: BTreeMap<String, Value>,
    deleted: Vec<String>,
    deleted_agent_replicas: Vec<Value>,
    replace_on_get: BTreeMap<String, Value>,
    replace_on_delete: BTreeMap<String, Value>,
    conflicts: Vec<String>,
    fail_get: Option<String>,
    fail_patch: Option<String>,
    fail_pin_release: bool,
    replace_on_patch: BTreeMap<String, Value>,
    patches: Vec<(String, Value)>,
    controller_enabled: bool,
    fence_gate: Option<Arc<FenceGate>>,
    replacement_after_resume: Option<Value>,
}

async fn kubernetes(
    State(cluster): State<Arc<Mutex<Cluster>>>,
    method: Method,
    uri: Uri,
    Query(query): Query<BTreeMap<String, String>>,
    body: Bytes,
) -> (StatusCode, Json<Value>) {
    if method == Method::PATCH && uri.path().starts_with(SANDBOXES) {
        let patch: Value = serde_json::from_slice(&body).unwrap();
        if patch["spec"]["shutdownTime"].is_string() {
            let gate = cluster.lock().await.fence_gate.take();
            if let Some(gate) = gate {
                gate.entered.notify_one();
                gate.release.notified().await;
            }
        }
    }
    let mut cluster = cluster.lock().await;
    let path = uri.path();
    reconcile_controller(&mut cluster);
    if method == Method::GET {
        if cluster.fail_get.as_deref() == Some(path) {
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "ServiceUnavailable");
        }
        if let Some(replacement) = cluster.replace_on_get.remove(path) {
            cluster.resources.insert(path.to_owned(), replacement);
        }
        if let Some(resource) = cluster.resources.get(path) {
            return (StatusCode::OK, Json(resource.clone()));
        }
        if [SANDBOXES, PODS, SERVICES, POLICIES].contains(&path) {
            let items = cluster
                .resources
                .iter()
                .filter(|(key, resource)| {
                    key.rsplit_once('/').map(|(parent, _)| parent) == Some(path)
                        && query.get("labelSelector").is_none_or(|selector| {
                            selector.split(',').all(|term| {
                                let (key, value) = term.split_once('=').unwrap();
                                resource["metadata"]["labels"][key] == value
                            })
                        })
                })
                .map(|(_, resource)| resource.clone())
                .collect::<Vec<_>>();
            return (
                StatusCode::OK,
                Json(json!({"metadata": {}, "items": items})),
            );
        }
    } else if method == Method::PATCH {
        if cluster.fail_patch.as_deref() == Some(path) {
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "ServiceUnavailable");
        }
        let patch: Value = serde_json::from_slice(&body).unwrap();
        if cluster.fail_pin_release
            && path == format!("{PODS}/asbx-test")
            && patch["metadata"]["finalizers"] == json!([])
        {
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "ServiceUnavailable");
        }
        if let Some(replacement) = cluster.replace_on_patch.remove(path) {
            cluster.resources.insert(path.to_owned(), replacement);
        }
        if let Some(resource) = cluster.resources.get_mut(path) {
            for field in ["uid", "resourceVersion"] {
                if patch["metadata"][field].is_string()
                    && patch["metadata"][field] != resource["metadata"][field]
                {
                    cluster.conflicts.push(path.to_owned());
                    return api_error(StatusCode::CONFLICT, "Conflict");
                }
            }
            let previous_spec = resource["spec"].clone();
            merge_patch(resource, &patch);
            if path.starts_with(SANDBOXES) && previous_spec != resource["spec"] {
                resource["metadata"]["generation"] =
                    json!(resource["metadata"]["generation"].as_u64().unwrap_or(1) + 1);
            }
            bump_revision(resource);
            let result = resource.clone();
            if patch["metadata"]["annotations"][retirement::RESUME_ANNOTATION].is_string()
                && let Some(pod) = cluster.replacement_after_resume.take()
            {
                cluster.resources.insert(format!("{PODS}/asbx-test"), pod);
            }
            cluster.patches.push((path.to_owned(), patch));
            return (StatusCode::OK, Json(result));
        }
    } else if method == Method::DELETE {
        let params: Value = serde_json::from_slice(&body).unwrap();
        if let Some(replacement) = cluster.replace_on_delete.remove(path) {
            cluster.resources.insert(path.to_owned(), replacement);
        }
        if let Some(resource) = cluster.resources.get(path) {
            for field in ["uid", "resourceVersion"] {
                if path == format!("{PODS}/asbx-test") && field == "resourceVersion" {
                    continue;
                }
                if !path.contains("proxy")
                    && !path.ends_with("egress")
                    && !params["preconditions"][field].is_string()
                {
                    continue;
                }
                assert!(
                    params["preconditions"][field].is_string(),
                    "cleanup must condition deletion on the observed resource at {path}"
                );
                if params["preconditions"][field] != resource["metadata"][field] {
                    cluster.conflicts.push(path.to_owned());
                    return api_error(StatusCode::CONFLICT, "Conflict");
                }
            }
            if resource["metadata"]["finalizers"]
                .as_array()
                .is_some_and(|values| !values.is_empty())
            {
                let resource = cluster.resources.get_mut(path).unwrap();
                resource["metadata"]["deletionTimestamp"] = timestamp(0);
                bump_revision(resource);
                return (StatusCode::OK, Json(resource.clone()));
            }
            let resource = cluster.resources.remove(path).unwrap();
            if path == format!("{PODS}/asbx-test") {
                let replicas =
                    cluster.resources[&format!("{SANDBOXES}/asbx-test")]["spec"]["replicas"]
                        .clone();
                cluster.deleted_agent_replicas.push(replicas);
            }
            cluster.deleted.push(path.to_owned());
            return (StatusCode::OK, Json(resource));
        }
    } else {
        panic!("unexpected Kubernetes mutation: {method} {path}");
    }
    api_error(StatusCode::NOT_FOUND, "NotFound")
}

fn merge_patch(target: &mut Value, patch: &Value) {
    if let Some(entries) = patch.as_object() {
        if !target.is_object() {
            *target = json!({});
        }
        for (key, value) in entries {
            if value.is_null() {
                target.as_object_mut().unwrap().remove(key);
            } else {
                merge_patch(&mut target[key], value);
            }
        }
    } else {
        *target = patch.clone();
    }
}

fn bump_revision(resource: &mut Value) {
    let revision = resource["metadata"]["resourceVersion"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap_or(1);
    resource["metadata"]["resourceVersion"] = json!((revision + 1).to_string());
}

// Models only the pinned controller's expiry and absent-Pod creation boundary;
// real Kind tests cover its implementation. A finalizer blocks name reuse.
fn reconcile_controller(cluster: &mut Cluster) {
    if !cluster.controller_enabled {
        return;
    }
    let sandbox_path = format!("{SANDBOXES}/asbx-test");
    let pod_path = format!("{PODS}/asbx-test");
    let Some(sandbox) = cluster.resources.get_mut(&sandbox_path) else {
        return;
    };
    let expired = sandbox["spec"]["shutdownTime"]
        .as_str()
        .and_then(|value| value.parse::<jiff::Timestamp>().ok())
        .is_some_and(|deadline| deadline <= jiff::Timestamp::now());
    if expired {
        let generation = sandbox["metadata"]["generation"].clone();
        if sandbox["status"]["conditions"][0]["observedGeneration"] != generation {
            sandbox["status"] = json!({"conditions": [{
                "type": "Ready", "status": "False", "reason": "SandboxExpired",
                "message": "expired", "lastTransitionTime": timestamp(0),
                "observedGeneration": generation
            }]});
            bump_revision(sandbox);
        }
    }
    if expired || sandbox["spec"]["replicas"] == 0 {
        if let Some(pod) = cluster.resources.get_mut(&pod_path) {
            if pod["metadata"]["finalizers"]
                .as_array()
                .is_some_and(|values| !values.is_empty())
            {
                if pod["metadata"]["deletionTimestamp"].is_null() {
                    pod["metadata"]["deletionTimestamp"] = timestamp(0);
                    bump_revision(pod);
                }
            } else {
                cluster.resources.remove(&pod_path);
            }
        }
    } else if let std::collections::btree_map::Entry::Vacant(entry) =
        cluster.resources.entry(pod_path.clone())
    {
        let mut pod = fixture("Running").resources.remove(&pod_path).unwrap();
        pod["metadata"]["uid"] = json!("controller-replacement");
        pod["metadata"]["creationTimestamp"] = timestamp(0);
        pod["status"]["conditions"] = json!([{"type": "Ready", "status": "True"}]);
        entry.insert(pod);
    }
}

fn api_error(code: StatusCode, reason: &str) -> (StatusCode, Json<Value>) {
    (
        code,
        Json(
            json!({"kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": reason, "message": reason, "code": code.as_u16()}),
        ),
    )
}

fn timestamp(age: u64) -> Value {
    json!(
        jiff::Timestamp::try_from(SystemTime::now() - Duration::from_secs(age))
            .unwrap()
            .to_string()
    )
}

fn fixture(phase: &str) -> Cluster {
    let mut config = AgentSandboxConfig::new("test", test_iron_control_settings());
    config.state_volume = Some(StateVolumeConfig::new("/state", "1Gi"));
    let mut sandbox = serde_json::to_value(
        build_agent_sandbox(
            &SandboxId::new("asbx-test"),
            &SandboxSpec::new("agent:test"),
            &config,
        )
        .unwrap(),
    )
    .unwrap();
    sandbox["metadata"]["uid"] = json!("sandbox-uid");
    sandbox["metadata"]["resourceVersion"] = json!("1");
    sandbox["metadata"]["generation"] = json!(1);
    sandbox["metadata"]["creationTimestamp"] = timestamp(3600);
    let owner = json!([{
        "apiVersion": "agents.x-k8s.io/v1alpha1", "kind": "Sandbox",
        "name": "asbx-test", "uid": "sandbox-uid"
    }]);
    let mut cluster = Cluster {
        controller_enabled: true,
        ..Cluster::default()
    };
    cluster
        .resources
        .insert(format!("{SANDBOXES}/asbx-test"), sandbox);
    for (collection, kind, name, age, proxy) in [
        (PODS, "Pod", "asbx-test", 3500, false),
        (PODS, "Pod", "asbx-test-proxy-old", 3600, true),
        (SERVICES, "Service", "asbx-test-proxy", 3600, true),
        (POLICIES, "NetworkPolicy", "asbx-test-proxy", 3600, true),
        (POLICIES, "NetworkPolicy", "asbx-test-egress", 3600, false),
    ] {
        let mut resource = json!({
            "apiVersion": if collection == POLICIES { "networking.k8s.io/v1" } else { "v1" },
            "kind": kind,
            "metadata": {
                "name": name, "uid": format!("{kind}-{name}-uid"), "resourceVersion": "1",
                "creationTimestamp": timestamp(age), "ownerReferences": owner,
                "labels": { MANAGED_BY_LABEL: MANAGED_BY_VALUE, SANDBOX_ID_LABEL: "asbx-test" }
            }
        });
        if proxy {
            resource["metadata"]["labels"][IRON_PROXY_LABEL] = json!("true");
        }
        if kind == "Pod" {
            resource["status"] = json!({ "phase": if proxy { "Running" } else { phase } });
        }
        cluster
            .resources
            .insert(format!("{collection}/{name}"), resource);
    }
    for (collection, kind, name) in [
        (
            "persistentvolumeclaims",
            "PersistentVolumeClaim",
            crate::state_pvc_name(&SandboxId::new("asbx-test")),
        ),
        (
            "configmaps",
            "ConfigMap",
            crate::sandbox_files_config_map_name(&SandboxId::new("asbx-test")),
        ),
    ] {
        cluster.resources.insert(
            format!("/api/v1/namespaces/test/{collection}/{name}"),
            json!({ "apiVersion": "v1", "kind": kind, "metadata": { "name": name, "uid": format!("{kind}-state") } }),
        );
    }
    cluster
}

async fn backend(
    cluster: Cluster,
) -> (
    AgentSandboxBackend,
    Arc<Mutex<Cluster>>,
    tokio::task::JoinHandle<()>,
) {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let cluster = Arc::new(Mutex::new(cluster));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut config = kube::Config::new(
        format!("http://{}", listener.local_addr().unwrap())
            .parse()
            .unwrap(),
    );
    config.default_retry = false;
    let client = kube::Client::try_from(config).unwrap();
    let app = Router::new()
        .fallback(kubernetes)
        .with_state(Arc::clone(&cluster));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut backend_config = AgentSandboxConfig::new("test", test_iron_control_settings());
    backend_config.state_volume = Some(StateVolumeConfig::new("/state", "1Gi"));
    backend_config.terminal_proxy_retirement_enabled = true;
    (
        AgentSandboxBackend::new(client, backend_config),
        cluster,
        server,
    )
}

#[tokio::test]
async fn cleanup_does_not_start_terminal_retirement_by_default() {
    let initial = fixture("Failed");
    let expected = initial.resources.clone();
    let (mut backend, cluster, server) = backend(initial).await;
    backend.config = AgentSandboxConfig::new("test", test_iron_control_settings())
        .state_volume(StateVolumeConfig::new("/state", "1Gi"));

    let counts = backend
        .reap_orphan_iron_proxy_resources(GRACE)
        .await
        .unwrap();

    assert!(counts.values().all(|count| *count == 0));
    assert_eq!(cluster.lock().await.resources, expected);
    server.abort();
}

#[tokio::test]
async fn cleanup_retires_terminal_proxies_and_preserves_sandbox_and_storage() {
    for phase in ["Failed", "Succeeded"] {
        let initial = fixture(phase);
        let retained = initial
            .resources
            .iter()
            .filter(|(path, _)| {
                path.contains("configmaps") || path.contains("persistentvolumeclaims")
            })
            .map(|(path, resource)| (path.clone(), resource.clone()))
            .collect::<BTreeMap<_, _>>();
        let (mut backend, cluster, server) = backend(initial).await;

        let counts = backend
            .reap_orphan_iron_proxy_resources(GRACE)
            .await
            .unwrap();

        assert_eq!(
            counts,
            BTreeMap::from([
                ("pod".to_owned(), 1),
                ("service".to_owned(), 1),
                ("network_policy".to_owned(), 2)
            ])
        );
        {
            let state = cluster.lock().await;
            for (path, resource) in retained {
                assert_eq!(state.resources[&path], resource);
            }
            assert_eq!(state.resources.len(), 3);
            assert_eq!(
                state.resources[&format!("{SANDBOXES}/asbx-test")]["metadata"]["uid"],
                "sandbox-uid"
            );
            assert!(!state.resources.contains_key(&format!("{PODS}/asbx-test")));
        }
        backend.config.terminal_proxy_retirement_enabled = false;
        let id = SandboxId::new("asbx-test");
        assert_eq!(
            backend.status(&id).await.unwrap(),
            centaur_sandbox_core::SandboxStatus::Stopped
        );
        assert_eq!(
            backend.observe(&id).await.unwrap().status,
            centaur_sandbox_core::SandboxStatus::Stopped
        );
        assert_eq!(
            backend.list_observed().await.unwrap()[0].status,
            centaur_sandbox_core::SandboxStatus::Stopped
        );
        let counts = backend
            .reap_orphan_iron_proxy_resources(GRACE)
            .await
            .unwrap();
        assert!(
            counts.values().all(|count| *count == 0),
            "cleanup must be retryable"
        );
        assert!(
            backend.resume(&id).await.is_err(),
            "a retired owner requires working proxy configuration to resume"
        );
        assert_eq!(
            backend.status(&id).await.unwrap(),
            centaur_sandbox_core::SandboxStatus::Stopped
        );
        server.abort();
    }
}

#[tokio::test]
async fn cleanup_fences_terminal_owner_before_controller_can_replace_agent() {
    let (backend, cluster, server) = backend(fixture("Failed")).await;
    backend
        .reap_orphan_iron_proxy_resources(GRACE)
        .await
        .unwrap();
    let state = cluster.lock().await;
    let sandbox = &state.resources[&format!("{SANDBOXES}/asbx-test")];
    assert!(
        sandbox["spec"]["shutdownTime"].is_string(),
        "terminal cleanup must prevent the controller from replacing a collected agent"
    );
    assert_eq!(sandbox["spec"]["shutdownPolicy"], "Retain");
    server.abort();
}

#[tokio::test]
async fn cleanup_preserves_active_and_uncertain_agents() {
    for phase in ["Running", "Pending", "Unknown", ""] {
        let initial = fixture(phase);
        let expected = initial.resources.clone();
        let (backend, cluster, server) = backend(initial).await;
        let counts = backend
            .reap_orphan_iron_proxy_resources(GRACE)
            .await
            .unwrap();
        assert!(counts.values().all(|count| *count == 0), "phase {phase}");
        assert_eq!(cluster.lock().await.resources, expected, "phase {phase}");
        server.abort();
    }
}

#[tokio::test]
async fn cleanup_preserves_missing_or_mismatched_owner_evidence() {
    let agent = format!("{PODS}/asbx-test");
    let sandbox = format!("{SANDBOXES}/asbx-test");
    for (path, pointer, value) in [
        (
            &agent,
            "/metadata/ownerReferences/0/uid",
            json!("another-owner"),
        ),
        (&agent, "/metadata/uid", Value::Null),
        (&agent, "/metadata/creationTimestamp", Value::Null),
        (&sandbox, "/metadata/uid", json!("replacement-owner")),
        (&sandbox, "/metadata/resourceVersion", Value::Null),
        (&sandbox, "/spec/replicas", json!(0)),
    ] {
        let mut initial = fixture("Failed");
        initial.controller_enabled = false;
        *initial
            .resources
            .get_mut(path)
            .unwrap()
            .pointer_mut(pointer)
            .unwrap() = value;
        let expected = initial.resources.clone();
        let (backend, cluster, server) = backend(initial).await;
        backend
            .reap_orphan_iron_proxy_resources(GRACE)
            .await
            .unwrap();
        assert_eq!(cluster.lock().await.resources, expected, "{path} {pointer}");
        server.abort();
    }
    let mut initial = fixture("Failed");
    initial.controller_enabled = false;
    initial.resources.remove(&agent);
    let expected = initial.resources.clone();
    let (backend, cluster, server) = backend(initial).await;
    backend
        .reap_orphan_iron_proxy_resources(GRACE)
        .await
        .unwrap();
    assert_eq!(cluster.lock().await.resources, expected);
    server.abort();
}

#[tokio::test]
async fn cleanup_protects_proxy_grace_and_resume_generations() {
    let same_generation_timestamp = timestamp(3500);
    for (pointer, value) in [
        ("/metadata/creationTimestamp", timestamp(60)),
        // Older than grace, but newer than the terminal agent: a stalled resume.
        ("/metadata/creationTimestamp", timestamp(1000)),
        (
            "/metadata/creationTimestamp",
            same_generation_timestamp.clone(),
        ),
        ("/metadata/creationTimestamp", Value::Null),
        ("/metadata/ownerReferences", Value::Null),
        ("/metadata/uid", Value::Null),
        ("/metadata/resourceVersion", Value::Null),
    ] {
        let mut initial = fixture("Failed");
        initial
            .resources
            .get_mut(&format!("{PODS}/asbx-test"))
            .unwrap()["metadata"]["creationTimestamp"] = same_generation_timestamp.clone();
        for (path, resource) in &mut initial.resources {
            if path.contains("proxy") || path.ends_with("egress") {
                *resource.pointer_mut(pointer).unwrap() = value.clone();
            }
        }
        let expected = initial.resources.clone();
        let (backend, cluster, server) = backend(initial).await;
        backend
            .reap_orphan_iron_proxy_resources(GRACE)
            .await
            .unwrap();
        assert_eq!(
            cluster.lock().await.resources,
            expected,
            "{pointer} {value}"
        );
        server.abort();
    }
}

#[tokio::test]
async fn cleanup_rechecks_owners_and_agents_after_listing() {
    for (path, pointer, value) in [
        (
            format!("{SANDBOXES}/asbx-test"),
            "/metadata/uid",
            json!("new-owner"),
        ),
        (
            format!("{SANDBOXES}/asbx-test"),
            "/metadata/resourceVersion",
            json!("2"),
        ),
        (
            format!("{PODS}/asbx-test"),
            "/status/phase",
            json!("Running"),
        ),
    ] {
        let mut initial = fixture("Failed");
        let mut replacement = initial.resources[&path].clone();
        *replacement.pointer_mut(pointer).unwrap() = value;
        let mut expected = initial.resources.clone();
        expected.insert(path.clone(), replacement.clone());
        initial.replace_on_get.insert(path, replacement);
        let (backend, cluster, server) = backend(initial).await;
        backend
            .reap_orphan_iron_proxy_resources(GRACE)
            .await
            .unwrap();
        assert_eq!(cluster.lock().await.resources, expected);
        assert!(cluster.lock().await.deleted.is_empty());
        server.abort();
    }
}

#[tokio::test]
async fn cleanup_cannot_delete_proxy_replacements_after_terminal_detection() {
    for (collection, name) in [
        (PODS, "asbx-test-proxy-old"),
        (SERVICES, "asbx-test-proxy"),
        (POLICIES, "asbx-test-egress"),
    ] {
        for field in ["uid", "resourceVersion"] {
            let mut initial = fixture("Failed");
            let path = format!("{collection}/{name}");
            let mut replacement = initial.resources[&path].clone();
            replacement["metadata"][field] = json!("replacement");
            replacement["metadata"]["creationTimestamp"] = timestamp(0);
            initial
                .replace_on_delete
                .insert(path.clone(), replacement.clone());
            let (backend, cluster, server) = backend(initial).await;
            backend
                .reap_orphan_iron_proxy_resources(GRACE)
                .await
                .unwrap();
            assert_eq!(cluster.lock().await.resources[&path], replacement);
            assert_eq!(cluster.lock().await.conflicts, vec![path.clone()]);
            backend
                .reap_orphan_iron_proxy_resources(GRACE)
                .await
                .unwrap();
            assert_eq!(cluster.lock().await.resources[&path], replacement);
            server.abort();
        }
    }
}

#[tokio::test]
async fn cleanup_fails_closed_when_owner_or_agent_cannot_be_read() {
    for path in [
        format!("{SANDBOXES}/asbx-test"),
        format!("{PODS}/asbx-test"),
    ] {
        let mut initial = fixture("Failed");
        initial.fail_get = Some(path);
        let expected = initial.resources.clone();
        let (backend, cluster, server) = backend(initial).await;
        assert!(
            backend
                .reap_orphan_iron_proxy_resources(GRACE)
                .await
                .is_err()
        );
        assert_eq!(cluster.lock().await.resources, expected);
        assert!(cluster.lock().await.deleted.is_empty());
        server.abort();
    }
}

#[tokio::test]
async fn cleanup_still_reaps_absent_owners_but_rechecks_new_owners() {
    for owner_created in [false, true] {
        let mut initial = fixture("Failed");
        let path = format!("{SANDBOXES}/asbx-test");
        let sandbox = initial.resources.remove(&path).unwrap();
        if owner_created {
            initial.replace_on_get.insert(path, sandbox);
        }
        let (backend, cluster, server) = backend(initial).await;
        let counts = backend
            .reap_orphan_iron_proxy_resources(GRACE)
            .await
            .unwrap();
        if owner_created {
            assert!(counts.values().all(|count| *count == 0));
            assert!(cluster.lock().await.deleted.is_empty());
        } else {
            assert_eq!(counts["pod"], 1);
            assert_eq!(counts["service"], 1);
            assert_eq!(counts["network_policy"], 2);
        }
        server.abort();
    }
}

#[tokio::test]
async fn cleanup_rejects_active_controller_replacement_before_pin() {
    let mut initial = fixture("Failed");
    let path = format!("{PODS}/asbx-test");
    let mut replacement = initial.resources[&path].clone();
    replacement["metadata"]["uid"] = json!("new-agent");
    replacement["metadata"]["resourceVersion"] = json!("2");
    replacement["status"] =
        json!({"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}]});
    initial
        .replace_on_patch
        .insert(path.clone(), replacement.clone());
    let (backend, cluster, server) = backend(initial).await;
    backend
        .reap_orphan_iron_proxy_resources(GRACE)
        .await
        .unwrap();
    assert_eq!(
        backend.status(&SandboxId::new("asbx-test")).await.unwrap(),
        centaur_sandbox_core::SandboxStatus::Running
    );
    let state = cluster.lock().await;
    assert_eq!(state.resources[&path], replacement);
    assert!(state.resources[&format!("{SANDBOXES}/asbx-test")]["spec"]["shutdownTime"].is_null());
    assert!(state.deleted.is_empty());
    assert_eq!(state.conflicts, vec![path]);
    server.abort();
}

#[tokio::test]
async fn cleanup_preserves_mixed_generations_and_tracked_active_pods() {
    for case in [
        "fresh-service",
        "terminating-proxy",
        "different-tracked-pod",
        "future-agent",
    ] {
        let mut initial = fixture("Failed");
        match case {
            "fresh-service" => {
                initial
                    .resources
                    .get_mut(&format!("{SERVICES}/asbx-test-proxy"))
                    .unwrap()["metadata"]["creationTimestamp"] = timestamp(1000)
            }
            "terminating-proxy" => {
                initial
                    .resources
                    .get_mut(&format!("{PODS}/asbx-test-proxy-old"))
                    .unwrap()["metadata"]["deletionTimestamp"] = timestamp(0)
            }
            "different-tracked-pod" => {
                initial
                    .resources
                    .get_mut(&format!("{SANDBOXES}/asbx-test"))
                    .unwrap()["metadata"]["annotations"]["agents.x-k8s.io/pod-name"] =
                    json!("another-live-pod")
            }
            "future-agent" => {
                initial
                    .resources
                    .get_mut(&format!("{PODS}/asbx-test"))
                    .unwrap()["metadata"]["creationTimestamp"] = json!("2999-01-01T00:00:00Z")
            }
            _ => unreachable!(),
        }
        let expected = initial.resources.clone();
        let (backend, cluster, server) = backend(initial).await;
        backend
            .reap_orphan_iron_proxy_resources(GRACE)
            .await
            .unwrap();
        assert_eq!(cluster.lock().await.resources, expected, "{case}");
        server.abort();
    }
}

#[tokio::test]
async fn cleanup_recovers_crashes_and_transient_failures_without_companions() {
    let owner = format!("{SANDBOXES}/asbx-test");
    let agent = format!("{PODS}/asbx-test");
    let mut initial = fixture("Failed");
    initial.controller_enabled = false;
    initial.fail_patch = Some(owner.clone());
    let (mut backend, cluster, server) = backend(initial).await;
    assert!(
        backend
            .reap_orphan_iron_proxy_resources(GRACE)
            .await
            .is_err()
    );
    backend.config.terminal_proxy_retirement_enabled = false;
    let decision;
    {
        let mut state = cluster.lock().await;
        let pod = state.resources.get_mut(&agent).unwrap();
        assert_eq!(
            pod["metadata"]["finalizers"],
            json!([retirement::RETIREMENT_ANNOTATION])
        );
        decision = pod["metadata"]["annotations"][retirement::RETIREMENT_ANNOTATION].clone();
        // PodGC requests deletion while the worker is gone. The pinned name
        // remains occupied, so no new workload can be admitted on this owner.
        pod["metadata"]["deletionTimestamp"] = timestamp(0);
        bump_revision(pod);
        state
            .resources
            .retain(|path, _| !path.contains("proxy") && !path.ends_with("egress"));
        state.fail_patch = None;
        state.fail_get = Some(owner.clone());
    }
    assert!(
        backend
            .reap_orphan_iron_proxy_resources(GRACE)
            .await
            .is_err()
    );
    assert_eq!(
        cluster.lock().await.resources[&agent]["metadata"]["annotations"]
            [retirement::RETIREMENT_ANNOTATION],
        decision
    );
    cluster.lock().await.fail_get = None;
    backend
        .reap_orphan_iron_proxy_resources(GRACE)
        .await
        .unwrap();
    {
        let state = cluster.lock().await;
        assert!(state.resources[&owner]["spec"]["shutdownTime"].is_string());
        assert_eq!(
            state.resources[&agent]["metadata"]["annotations"][retirement::RETIREMENT_ANNOTATION],
            decision
        );
    }
    // A restart after the owner fence keeps the Pod pinned until the
    // controller has acknowledged the fenced generation.
    backend
        .reap_orphan_iron_proxy_resources(GRACE)
        .await
        .unwrap();
    assert!(cluster.lock().await.resources.contains_key(&agent));
    assert_eq!(
        backend
            .observe(&SandboxId::new("asbx-test"))
            .await
            .unwrap()
            .status,
        centaur_sandbox_core::SandboxStatus::Stopped
    );
    cluster.lock().await.controller_enabled = true;
    backend
        .reap_orphan_iron_proxy_resources(GRACE)
        .await
        .unwrap();
    assert!(!cluster.lock().await.resources.contains_key(&agent));
    assert_eq!(cluster.lock().await.resources.len(), 3);
    server.abort();
}

#[tokio::test]
async fn cleanup_sweepers_share_the_original_pinned_decision() {
    let owner = format!("{SANDBOXES}/asbx-test");
    let mut initial = fixture("Succeeded");
    initial.controller_enabled = false;
    initial.fail_patch = Some(owner.clone());
    let (backend, cluster, server) = backend(initial).await;
    assert!(
        backend
            .reap_orphan_iron_proxy_resources(GRACE)
            .await
            .is_err()
    );
    {
        let mut state = cluster.lock().await;
        state.fail_patch = None;
        state.controller_enabled = true;
    }
    let (first, second) = tokio::join!(
        backend.reap_orphan_iron_proxy_resources(GRACE),
        backend.reap_orphan_iron_proxy_resources(GRACE)
    );
    first.unwrap();
    second.unwrap();
    let state = cluster.lock().await;
    let decision: Value = serde_json::from_str(
        state.resources[&owner]["metadata"]["annotations"][retirement::RETIREMENT_ANNOTATION]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(decision["owner_revision"], "1");
    assert_eq!(
        state
            .patches
            .iter()
            .filter(|(path, patch)| path == &owner && patch["spec"]["shutdownTime"].is_string())
            .count(),
        1
    );
    assert_eq!(state.resources.len(), 3);
    server.abort();
}

#[tokio::test]
async fn cleanup_cannot_commit_a_delayed_decision_after_explicit_resume() {
    let gate = Arc::new(FenceGate::default());
    let mut initial = fixture("Failed");
    initial.fence_gate = Some(Arc::clone(&gate));
    let (backend, cluster, server) = backend(initial).await;
    let backend = Arc::new(backend);
    let sweeping = {
        let backend = Arc::clone(&backend);
        tokio::spawn(async move { backend.reap_orphan_iron_proxy_resources(GRACE).await })
    };
    tokio::time::timeout(Duration::from_secs(5), gate.entered.notified())
        .await
        .unwrap();
    {
        let mut state = cluster.lock().await;
        for (path, resource) in &mut state.resources {
            if path.contains("proxy") || path.ends_with("egress") {
                resource["metadata"]["creationTimestamp"] = timestamp(0);
                bump_revision(resource);
            }
        }
    }
    backend.resume(&SandboxId::new("asbx-test")).await.unwrap();
    gate.release.notify_one();
    sweeping.await.unwrap().unwrap();
    let id = SandboxId::new("asbx-test");
    assert_eq!(
        backend.status(&id).await.unwrap(),
        centaur_sandbox_core::SandboxStatus::Running
    );
    let state = cluster.lock().await;
    let owner = &state.resources[&format!("{SANDBOXES}/asbx-test")];
    assert!(owner["spec"]["shutdownTime"].is_null());
    assert!(owner["metadata"]["annotations"][retirement::RESUME_ANNOTATION].is_string());
    assert!(state.conflicts.contains(&format!("{SANDBOXES}/asbx-test")));
    assert!(
        !state
            .deleted
            .iter()
            .any(|path| path.contains("proxy") || path.ends_with("egress"))
    );
    server.abort();
}

#[tokio::test]
async fn cleanup_preserves_operator_lifecycle_intent() {
    for patch in [
        json!({"shutdownTime": "2999-01-01T00:00:00Z"}),
        json!({"shutdownTime": "2000-01-01T00:00:00Z"}),
        json!({"shutdownPolicy": "Delete"}),
        json!({"shutdownPolicy": null}),
        json!({"replicas": 0}),
    ] {
        let mut initial = fixture("Failed");
        initial.controller_enabled = false;
        merge_patch(
            &mut initial
                .resources
                .get_mut(&format!("{SANDBOXES}/asbx-test"))
                .unwrap()["spec"],
            &patch,
        );
        let expected = initial.resources.clone();
        let (backend, cluster, server) = backend(initial).await;
        backend
            .reap_orphan_iron_proxy_resources(GRACE)
            .await
            .unwrap();
        assert_eq!(cluster.lock().await.resources, expected);
        server.abort();
    }
}

#[tokio::test]
async fn cleanup_pin_release_failure_preserves_the_fence_and_retries() {
    let mut initial = fixture("Failed");
    initial.fail_pin_release = true;
    let (mut backend, cluster, server) = backend(initial).await;
    assert!(
        backend
            .reap_orphan_iron_proxy_resources(GRACE)
            .await
            .is_err()
    );
    {
        let state = cluster.lock().await;
        assert!(
            state.resources[&format!("{PODS}/asbx-test")]["metadata"]["finalizers"]
                .as_array()
                .unwrap()
                .contains(&json!(retirement::RETIREMENT_ANNOTATION))
        );
        assert!(
            state.resources[&format!("{SANDBOXES}/asbx-test")]["spec"]["shutdownTime"].is_string()
        );
        assert!(state.deleted.is_empty());
    }
    backend.config.terminal_proxy_retirement_enabled = false;
    cluster.lock().await.fail_pin_release = false;
    backend
        .reap_orphan_iron_proxy_resources(GRACE)
        .await
        .unwrap();
    assert_eq!(cluster.lock().await.resources.len(), 3);
    server.abort();
}

#[tokio::test]
async fn cleanup_pause_invalidates_pin_and_preserves_foreign_finalizers() {
    let mut initial = fixture("Failed");
    initial.controller_enabled = false;
    initial.fail_patch = Some(format!("{SANDBOXES}/asbx-test"));
    initial
        .resources
        .get_mut(&format!("{PODS}/asbx-test"))
        .unwrap()["metadata"]["finalizers"] = json!(["example.test/retain"]);
    let (backend, cluster, server) = backend(initial).await;
    assert!(
        backend
            .reap_orphan_iron_proxy_resources(GRACE)
            .await
            .is_err()
    );
    {
        let mut state = cluster.lock().await;
        state.fail_patch = None;
        state
            .resources
            .retain(|path, _| !path.contains("proxy") && !path.ends_with("egress"));
    }
    backend.pause(&SandboxId::new("asbx-test")).await.unwrap();
    let state = cluster.lock().await;
    assert_eq!(
        state.resources[&format!("{PODS}/asbx-test")]["metadata"]["finalizers"],
        json!(["example.test/retain"])
    );
    assert!(
        state.resources[&format!("{PODS}/asbx-test")]["metadata"]["annotations"]
            [retirement::RETIREMENT_ANNOTATION]
            .is_null()
    );
    assert_eq!(
        state.resources[&format!("{SANDBOXES}/asbx-test")]["spec"]["replicas"],
        0
    );
    server.abort();
}

#[tokio::test]
async fn cleanup_pin_does_not_block_explicit_stop() {
    let mut initial = fixture("Failed");
    initial.controller_enabled = false;
    let (backend, cluster, server) = backend(initial).await;
    backend
        .reap_orphan_iron_proxy_resources(GRACE)
        .await
        .unwrap();
    {
        let mut state = cluster.lock().await;
        state
            .resources
            .retain(|path, _| !path.contains("proxy") && !path.ends_with("egress"));
        state.controller_enabled = true;
    }
    backend.stop(&SandboxId::new("asbx-test")).await.unwrap();
    assert!(cluster.lock().await.resources.is_empty());
    server.abort();
}

#[tokio::test]
async fn cleanup_resume_preserves_agent_created_after_intent_commit() {
    let mut initial = fixture("Running");
    initial
        .resources
        .get_mut(&format!("{PODS}/asbx-test"))
        .unwrap()["status"]["conditions"] = json!([{"type": "Ready", "status": "True"}]);
    initial.controller_enabled = false;
    initial
        .resources
        .get_mut(&format!("{SANDBOXES}/asbx-test"))
        .unwrap()["spec"]["replicas"] = json!(0);
    let mut replacement = initial.resources[&format!("{PODS}/asbx-test")].clone();
    replacement["metadata"]["uid"] = json!("resumed-agent");
    replacement["metadata"]["resourceVersion"] = json!("2");
    replacement["status"] =
        json!({"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}]});
    initial.replacement_after_resume = Some(replacement.clone());
    let (mut backend, cluster, server) = backend(initial).await;
    backend.config.ready_timeout = Duration::from_millis(50);
    backend.resume(&SandboxId::new("asbx-test")).await.unwrap();
    let state = cluster.lock().await;
    assert_eq!(state.deleted_agent_replicas, vec![json!(0)]);
    assert_eq!(state.resources[&format!("{PODS}/asbx-test")], replacement);
    server.abort();
}

#[tokio::test]
async fn cleanup_resume_preserves_agent_absent_before_intent_commit() {
    let mut initial = fixture("Pending");
    initial.controller_enabled = false;
    initial.resources.remove(&format!("{PODS}/asbx-test"));
    initial
        .resources
        .get_mut(&format!("{SANDBOXES}/asbx-test"))
        .unwrap()["spec"]["replicas"] = json!(0);
    let mut replacement = fixture("Running")
        .resources
        .remove(&format!("{PODS}/asbx-test"))
        .unwrap();
    replacement["metadata"]["uid"] = json!("resumed-after-absence");
    replacement["status"]["conditions"] = json!([{"type": "Ready", "status": "True"}]);
    initial.replacement_after_resume = Some(replacement.clone());
    let (mut backend, cluster, server) = backend(initial).await;
    backend.config.ready_timeout = Duration::from_millis(50);
    backend.resume(&SandboxId::new("asbx-test")).await.unwrap();
    let state = cluster.lock().await;
    assert_eq!(state.resources[&format!("{PODS}/asbx-test")], replacement);
    assert!(state.deleted.is_empty());
    server.abort();
}
