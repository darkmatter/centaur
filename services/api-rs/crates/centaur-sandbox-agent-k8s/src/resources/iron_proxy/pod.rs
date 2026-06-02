use centaur_sandbox_core::SandboxId;
use k8s_openapi::api::core::v1::{
    Capabilities, Container, Pod, PodSpec, SeccompProfile, SecurityContext,
};

use super::config::ResolvedIronProxy;
use super::names::iron_proxy_labels;
use crate::config::IronProxyPodConfig;
use crate::resources::common::{health_probe, image_pull_secret_refs, object_meta, volume_mount};

mod env;
mod ports;
mod volumes;

use env::{iron_proxy_env_from, iron_proxy_env_vars};
use ports::container_ports;
use volumes::iron_proxy_volumes;

pub(crate) fn build_iron_proxy_pod(
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

fn iron_proxy_container(
    iron_proxy: &IronProxyPodConfig,
    resolved: &ResolvedIronProxy,
) -> Container {
    Container {
        name: "iron-proxy".to_owned(),
        image: Some(iron_proxy.image.clone()),
        image_pull_policy: iron_proxy.image_pull_policy.clone(),
        env: Some(iron_proxy_env_vars(iron_proxy, resolved)),
        env_from: iron_proxy_env_from(iron_proxy),
        ports: Some(container_ports(resolved)),
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
