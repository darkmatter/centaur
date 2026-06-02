use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use centaur_sandbox_core::SandboxSpec;
use k8s_openapi::api::core::v1::{
    ContainerPort, EmptyDirVolumeSource, HTTPGetAction, LocalObjectReference, Probe,
    ResourceRequirements, SecretVolumeSource, ServicePort, Volume, VolumeMount,
};
use k8s_openapi::api::networking::v1::{
    NetworkPolicyEgressRule, NetworkPolicyPeer, NetworkPolicyPort,
};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, ObjectMeta};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use sha2::{Digest, Sha256};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub(crate) fn object_meta(name: impl Into<String>, labels: BTreeMap<String, String>) -> ObjectMeta {
    ObjectMeta {
        name: Some(name.into()),
        labels: Some(labels),
        ..Default::default()
    }
}

pub(super) fn container_port(name: impl Into<String>, port: u16) -> ContainerPort {
    ContainerPort {
        name: Some(name.into()),
        container_port: i32::from(port),
        ..Default::default()
    }
}

pub(super) fn service_port(name: impl Into<String>, port: u16) -> ServicePort {
    let port = i32::from(port);
    ServicePort {
        name: Some(name.into()),
        port,
        target_port: Some(IntOrString::Int(port)),
        protocol: Some("TCP".to_owned()),
        ..Default::default()
    }
}

pub(super) fn network_port(port: u16) -> NetworkPolicyPort {
    policy_port("TCP", port)
}

pub(super) fn udp_port(port: u16) -> NetworkPolicyPort {
    policy_port("UDP", port)
}

fn policy_port(protocol: &str, port: u16) -> NetworkPolicyPort {
    NetworkPolicyPort {
        port: Some(IntOrString::Int(i32::from(port))),
        protocol: Some(protocol.to_owned()),
        ..Default::default()
    }
}

pub(super) fn health_probe(period_seconds: Option<i32>, failure_threshold: Option<i32>) -> Probe {
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

pub(super) fn volume_mount(name: &str, mount_path: &str, read_only: bool) -> VolumeMount {
    VolumeMount {
        name: name.to_owned(),
        mount_path: mount_path.to_owned(),
        read_only: read_only.then_some(true),
        ..Default::default()
    }
}

pub(super) fn empty_dir_volume(name: &str) -> Volume {
    Volume {
        name: name.to_owned(),
        empty_dir: Some(EmptyDirVolumeSource::default()),
        ..Default::default()
    }
}

pub(super) fn secret_volume(name: &str, secret_name: impl Into<String>) -> Volume {
    Volume {
        name: name.to_owned(),
        secret: Some(SecretVolumeSource {
            secret_name: Some(secret_name.into()),
            ..Default::default()
        }),
        ..Default::default()
    }
}

pub(super) fn label_selector(match_labels: BTreeMap<String, String>) -> LabelSelector {
    LabelSelector {
        match_labels: Some(match_labels),
        ..Default::default()
    }
}

pub(super) fn pod_peer(match_labels: BTreeMap<String, String>) -> NetworkPolicyPeer {
    NetworkPolicyPeer {
        pod_selector: Some(label_selector(match_labels)),
        ..Default::default()
    }
}

pub(super) fn egress_to(
    to: Vec<NetworkPolicyPeer>,
    ports: Vec<NetworkPolicyPort>,
) -> NetworkPolicyEgressRule {
    NetworkPolicyEgressRule {
        to: Some(to),
        ports: Some(ports),
    }
}

pub(super) fn resources(spec: &SandboxSpec) -> Option<ResourceRequirements> {
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

pub(super) fn unique_suffix() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let sequence = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    format!("{millis}-{sequence}")
}

pub(crate) fn short_sha256(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) fn image_pull_secret_refs(names: &[String]) -> Option<Vec<LocalObjectReference>> {
    (!names.is_empty()).then(|| {
        names
            .iter()
            .map(|name| LocalObjectReference { name: name.clone() })
            .collect::<Vec<_>>()
    })
}

pub(crate) fn next_sandbox_name() -> String {
    format!("asbx-{}", unique_suffix())
}
