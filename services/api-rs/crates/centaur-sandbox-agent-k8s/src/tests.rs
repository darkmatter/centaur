use std::collections::BTreeMap;

use centaur_iron_proxy::SourcePolicy;
use centaur_sandbox_core::{CredentialProfile, ResourceLimits, SandboxSpec};
use k8s_openapi::api::core::v1::{Pod, PodCondition, PodStatus};

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

#[test]
fn codex_credential_profile_adds_openai_placeholder() {
    let iron_proxy = IronProxyPodConfig::new(
        "centaur-iron-proxy:latest",
        "firewall-ca-cert",
        "firewall-ca-key",
    );
    let spec =
        SandboxSpec::new("centaur-agent:latest").credential_profile(CredentialProfile::Codex);

    let fragments = iron_proxy_fragments_for_spec(&iron_proxy, &spec).unwrap();
    let placeholder_env = centaur_iron_proxy::placeholder_env(&fragments);

    assert_eq!(placeholder_env["OPENAI_API_KEY"], "OPENAI_API_KEY");
}

#[test]
fn builds_agent_sandbox_spec_with_limits() {
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
    let mut config = AgentSandboxConfig::new("centaur");
    config.image_pull_secrets = vec!["regcred".to_owned(), "mirrorcred".to_owned()];
    config.runtime_class_name = Some("gvisor".to_owned());
    config.service_account_name = Some("sandbox-agent".to_owned());

    let sandbox = build_agent_sandbox(&SandboxId::new("asbx-test"), &spec, &config, None).unwrap();

    assert_eq!(sandbox.metadata.name.as_deref(), Some("asbx-test"));
    assert_eq!(sandbox.spec.replicas, Some(1));
    assert_eq!(
        sandbox.spec.shutdown_policy,
        Some(crd::SandboxShutdownPolicy::Retain)
    );
    let container = &sandbox.spec.pod_template.spec.containers[0];
    assert_eq!(container.image.as_deref(), Some("centaur-agent:latest"));
    assert_eq!(container.stdin, Some(true));
    assert_eq!(container.volume_mounts.as_ref().unwrap().len(), 1);
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
fn security_model_agent_pod_gets_placeholders_not_proxy_secrets() {
    let mut iron_proxy = IronProxyPodConfig::new(
        "centaur-iron-proxy:latest",
        "firewall-ca-cert",
        "firewall-ca-key",
    );
    iron_proxy.source_policy = SourcePolicy::onepassword_connect("ai-agents", "10m");
    iron_proxy.secret_env_name = Some("centaur-infra-env".to_owned());
    iron_proxy.secret_env_prefix = "CENT_".to_owned();
    iron_proxy.token_broker_name = Some("centaur-token-broker".to_owned());
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
        .env("CENTAUR_API_KEY", "sbx1.placeholder");

    let sandbox =
        build_agent_sandbox(&SandboxId::new("asbx-sec"), &spec, &config, Some(&resolved)).unwrap();
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
    assert_eq!(env["FIREWALL_HOST"], "asbx-sec-proxy");
    assert_eq!(env["FIREWALL_PROXY_PORT"], "18080");
    assert_eq!(env["HTTPS_PROXY"], "http://asbx-sec-proxy:18080");
    assert_eq!(env["HTTP_PROXY"], "http://asbx-sec-proxy:18080");
    assert!(env["NO_PROXY"].contains("asbx-sec-proxy"));
    assert!(env["NO_PROXY"].contains("api"));
    assert_eq!(env["REQUESTS_CA_BUNDLE"], "/firewall-certs/ca-cert.pem");
    assert_eq!(env["CURL_CA_BUNDLE"], "/firewall-certs/ca-cert.pem");

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
    assert!(
        container
            .volume_mounts
            .as_ref()
            .unwrap()
            .iter()
            .any(|mount| {
                mount.name == "iron-proxy-ca-cert"
                    && mount.mount_path == "/firewall-certs"
                    && mount.read_only == Some(true)
            })
    );
    assert!(volumes.iter().any(|volume| {
        volume.name == "iron-proxy-ca-cert"
            && volume.secret.as_ref().unwrap().secret_name.as_deref() == Some("firewall-ca-cert")
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
fn builds_iron_proxy_pod_with_managed_token_broker() {
    let mut iron_proxy = IronProxyPodConfig::new(
        "centaur-iron-proxy:latest",
        "firewall-ca-cert",
        "firewall-ca-key",
    );
    iron_proxy.secret_env_name = Some("centaur-infra-env".to_owned());
    iron_proxy.secret_env_prefix = "CENT_".to_owned();
    iron_proxy.token_broker_name = Some("centaur-token-broker".to_owned());
    assert_eq!(
        iron_token_broker_configmap_name(&iron_proxy).unwrap(),
        "centaur-token-broker-config"
    );
    let resolved = ResolvedIronProxy {
        config_yaml: "transforms: []\n".to_owned(),
        placeholder_env: BTreeMap::new(),
        proxy_host: "asbx-sec-proxy".to_owned(),
        proxy_pod_name: "asbx-sec-proxy-123".to_owned(),
        proxy_port: 18080,
        listen_ports: vec![18080],
        pg_dsn_env: BTreeMap::new(),
        pg_proxy_password_env: BTreeMap::new(),
    };

    let pod = build_iron_proxy_pod(
        &SandboxId::new("asbx-sec"),
        "asbx-sec-proxy-123",
        &iron_proxy,
        &resolved,
    );
    let container = &pod.spec.as_ref().unwrap().containers[0];
    let env = container
        .env
        .as_ref()
        .unwrap()
        .iter()
        .map(|env| (env.name.as_str(), env))
        .collect::<BTreeMap<_, _>>();

    assert_eq!(
        env["IRON_BROKER_URL"].value.as_deref(),
        Some("http://centaur-token-broker:8181")
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

    let policies =
        build_iron_proxy_network_policies(&SandboxId::new("asbx-sec"), &resolved, &iron_proxy);
    let proxy_policy = policies
        .iter()
        .find(|policy| policy.metadata.name.as_deref() == Some("asbx-sec-proxy-net"))
        .unwrap();
    let egress = proxy_policy.spec.as_ref().unwrap().egress.as_ref().unwrap();
    assert!(egress.iter().any(|rule| {
        rule.to.as_ref().is_some_and(|peers| {
            peers.iter().any(|peer| {
                peer.pod_selector.as_ref().is_some_and(|selector| {
                    selector.match_labels.as_ref().is_some_and(|labels| {
                        labels.get("app.kubernetes.io/component")
                            == Some(&"token-broker".to_owned())
                    })
                })
            })
        }) && rule.ports.as_ref().is_some_and(|ports| {
            ports.iter().any(|port| {
                port.port.as_ref().is_some_and(|port| {
                    port == &k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::Int(8181)
                })
            })
        })
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
