use k8s_openapi::api::core::v1::ContainerPort;

use crate::resources::common::container_port;
use crate::resources::iron_proxy::ResolvedIronProxy;

pub(super) fn container_ports(resolved: &ResolvedIronProxy) -> Vec<ContainerPort> {
    let mut ports = vec![
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
        ports.push(container_port(format!("tcp-{port}"), port));
    }
    ports
}
