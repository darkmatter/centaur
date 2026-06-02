use centaur_sandbox_core::SandboxId;
use k8s_openapi::api::core::v1::{ConfigMapVolumeSource, Volume};

use crate::config::IronProxyPodConfig;
use crate::resources::common::{empty_dir_volume, secret_volume};
use crate::resources::iron_proxy::names::iron_proxy_configmap_name;

pub(super) fn iron_proxy_volumes(id: &SandboxId, iron_proxy: &IronProxyPodConfig) -> Vec<Volume> {
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
