use std::collections::BTreeMap;

use centaur_iron_proxy::SourceKind;
use centaur_sandbox_core::SandboxId;
use k8s_openapi::api::core::v1::{Service, ServiceSpec};
use k8s_openapi::api::networking::v1::{
    NetworkPolicy, NetworkPolicyEgressRule, NetworkPolicyIngressRule, NetworkPolicyPeer,
    NetworkPolicyPort, NetworkPolicySpec,
};

use super::config::ResolvedIronProxy;
use super::names::{
    iron_proxy_labels, iron_proxy_policy_name, iron_proxy_sandbox_egress_policy_name,
    iron_proxy_service_name, sandbox_labels, token_broker_pod_labels,
};
use crate::config::IronProxyPodConfig;
use crate::resources::common::{
    egress_to, label_selector, network_port, object_meta, pod_peer, service_port, udp_port,
};

pub(crate) fn build_iron_proxy_service(id: &SandboxId, resolved: &ResolvedIronProxy) -> Service {
    let mut ports = vec![service_port("proxy", resolved.proxy_port)];
    ports.extend(
        resolved
            .additional_listen_ports()
            .map(|port| service_port(format!("tcp-{port}"), port)),
    );
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

pub(crate) fn build_iron_proxy_network_policies(
    id: &SandboxId,
    resolved: &ResolvedIronProxy,
    iron_proxy: &IronProxyPodConfig,
) -> Vec<NetworkPolicy> {
    let sandbox_to_proxy_ports = sandbox_to_proxy_ports(resolved);
    vec![
        sandbox_egress_policy(id, iron_proxy, sandbox_to_proxy_ports.clone()),
        proxy_network_policy(id, iron_proxy, sandbox_to_proxy_ports),
    ]
}

fn sandbox_to_proxy_ports(resolved: &ResolvedIronProxy) -> Vec<NetworkPolicyPort> {
    std::iter::once(network_port(resolved.proxy_port))
        .chain(resolved.additional_listen_ports().map(network_port))
        .collect()
}

fn sandbox_egress_policy(
    id: &SandboxId,
    iron_proxy: &IronProxyPodConfig,
    sandbox_to_proxy_ports: Vec<k8s_openapi::api::networking::v1::NetworkPolicyPort>,
) -> NetworkPolicy {
    NetworkPolicy {
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
                    sandbox_to_proxy_ports,
                ),
                egress_to(
                    vec![pod_peer(iron_proxy.api_pod_labels.clone())],
                    vec![network_port(8000)],
                ),
                dns_egress_rule(),
            ]),
            ..Default::default()
        }),
    }
}

fn proxy_network_policy(
    id: &SandboxId,
    iron_proxy: &IronProxyPodConfig,
    sandbox_to_proxy_ports: Vec<k8s_openapi::api::networking::v1::NetworkPolicyPort>,
) -> NetworkPolicy {
    NetworkPolicy {
        metadata: object_meta(iron_proxy_policy_name(id), iron_proxy_labels(id)),
        spec: Some(NetworkPolicySpec {
            pod_selector: Some(label_selector(iron_proxy_labels(id))),
            policy_types: Some(vec!["Ingress".to_owned(), "Egress".to_owned()]),
            ingress: Some(vec![NetworkPolicyIngressRule {
                from: Some(vec![pod_peer(sandbox_labels(id))]),
                ports: Some(sandbox_to_proxy_ports),
            }]),
            egress: Some(proxy_egress_rules(iron_proxy)),
        }),
    }
}

fn proxy_egress_rules(iron_proxy: &IronProxyPodConfig) -> Vec<NetworkPolicyEgressRule> {
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
    proxy_egress
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
