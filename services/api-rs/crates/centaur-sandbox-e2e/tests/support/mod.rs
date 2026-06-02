#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use centaur_iron_proxy::{SourcePolicy, load_fragment_str};
use centaur_sandbox_agent_k8s::{
    AgentSandboxBackend, AgentSandboxConfig, IronProxyPodConfig, SandboxWarmPoolConfig,
};
use centaur_sandbox_core::{
    SandboxBackend, SandboxId, SandboxRead, SandboxSpec, SandboxStatus, SandboxWrite,
};
use centaur_sandbox_local::LocalSandboxBackend;
use centaur_sandbox_manager::{DriftReason, ReconcileOutcome, SandboxManager};
use clap::Parser;
use k8s_openapi::api::core::v1::{Endpoints, Pod, Secret, Service, ServicePort, ServiceSpec};
use k8s_openapi::api::networking::v1::{
    NetworkPolicy, NetworkPolicyIngressRule, NetworkPolicyPeer, NetworkPolicyPort,
    NetworkPolicySpec,
};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, ObjectMeta};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::api::{DeleteParams, ListParams, LogParams, PostParams};
use kube::config::KubeConfigOptions;
use kube::{Api, Client, Config};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::{interval, timeout};

const ALL_IMPLEMENTATIONS: &[&str] = &["local", "agent-k8s"];
const PROXY_E2E_PLACEHOLDER: &str = "TEST_API_TOKEN";
const PROXY_E2E_REAL_SECRET: &str = "real-env-secret-from-sandbox-e2e";
const RECEIVER_PORT: i32 = 443;
static NEXT_K8S_NAME: AtomicU64 = AtomicU64::new(0);

type TestResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

pub(crate) struct SandboxImplementation {
    name: &'static str,
    backend: Arc<dyn SandboxBackend>,
    reconnect_backend: Arc<dyn Fn() -> Arc<dyn SandboxBackend> + Send + Sync>,
    long_running_spec: SandboxSpec,
    short_lived_spec: SandboxSpec,
    byte_io_spec: SandboxSpec,
    invalid_spec: SandboxSpec,
}

pub(crate) struct ProxyE2eImplementation {
    name: &'static str,
    client: Client,
    namespace: String,
    receiver_backend: Arc<dyn SandboxBackend>,
    sender_backend: Arc<dyn SandboxBackend>,
    receiver_image: String,
    curl_image: String,
    receiver_host: String,
    receiver_service_name: String,
    ca_cert_secret_name: String,
    ca_key_secret_name: String,
    env_secret_name: String,
}

pub(crate) async fn implementation_if_requested(
    name: &'static str,
) -> Option<SandboxImplementation> {
    let args = E2eArgs::from_env();
    validate_requested_implementations(&args);
    if !args.includes_implementation(name) {
        return None;
    }

    Some(match name {
        "local" => local_implementation(),
        "agent-k8s" => agent_k8s_implementation().await,
        other => panic!("unknown sandbox e2e implementation {other:?}"),
    })
}

pub(crate) async fn proxy_implementation_if_requested(
    name: &'static str,
) -> Option<ProxyE2eImplementation> {
    let args = E2eArgs::from_env();
    validate_requested_implementations(&args);
    if !args.includes_implementation(name) {
        return None;
    }
    match name {
        "agent-k8s" => Some(agent_k8s_proxy_implementation().await),
        "local" => None,
        other => panic!("unknown sandbox e2e implementation {other:?}"),
    }
}

pub(crate) async fn create_stop_cleans_up(implementation: &SandboxImplementation) {
    let manager = SandboxManager::new(implementation.backend.clone());
    let handle = manager
        .create_running(implementation.long_running_spec.clone())
        .await
        .unwrap_or_else(|err| panic!("{} create failed: {err}", implementation.name));

    eventually_status(&manager, &handle.id, SandboxStatus::Running).await;

    manager
        .stop(&handle.id)
        .await
        .unwrap_or_else(|err| panic!("{} stop failed: {err}", implementation.name));
    eventually_status(&manager, &handle.id, SandboxStatus::Gone).await;
}

pub(crate) async fn pause_resume_restores_running(implementation: &SandboxImplementation) {
    let manager = SandboxManager::new(implementation.backend.clone());
    let handle = manager
        .create_running(implementation.long_running_spec.clone())
        .await
        .unwrap_or_else(|err| panic!("{} create failed: {err}", implementation.name));

    manager
        .pause(&handle.id)
        .await
        .unwrap_or_else(|err| panic!("{} pause failed: {err}", implementation.name));
    eventually_status(&manager, &handle.id, SandboxStatus::Suspended).await;

    manager
        .resume(&handle.id)
        .await
        .unwrap_or_else(|err| panic!("{} resume failed: {err}", implementation.name));
    eventually_status(&manager, &handle.id, SandboxStatus::Running).await;

    manager
        .stop(&handle.id)
        .await
        .unwrap_or_else(|err| panic!("{} stop failed: {err}", implementation.name));
}

pub(crate) async fn unexpected_shutdown_reports_drift(implementation: &SandboxImplementation) {
    let manager = SandboxManager::new(implementation.backend.clone());
    let handle = manager
        .create_running(implementation.short_lived_spec.clone())
        .await
        .unwrap_or_else(|err| panic!("{} create failed: {err}", implementation.name));

    eventually_status(&manager, &handle.id, SandboxStatus::Stopped).await;
    let outcome = manager
        .reconcile_one(&handle.id)
        .await
        .unwrap_or_else(|err| panic!("{} reconcile failed: {err}", implementation.name));

    assert_eq!(
        outcome,
        ReconcileOutcome::Drift(DriftReason::MissingWhileRunning),
        "{} should report drift when a desired-running sandbox exits",
        implementation.name
    );

    manager
        .stop(&handle.id)
        .await
        .unwrap_or_else(|err| panic!("{} cleanup stop failed: {err}", implementation.name));
}

pub(crate) async fn byte_io_round_trips(implementation: &SandboxImplementation) {
    let manager = SandboxManager::new(implementation.backend.clone());
    let handle = manager
        .create_running(implementation.byte_io_spec.clone())
        .await
        .unwrap_or_else(|err| {
            panic!(
                "{} create byte I/O sandbox failed: {err}",
                implementation.name
            )
        });

    let mut io = manager
        .open_io(&handle.id)
        .await
        .unwrap_or_else(|err| panic!("{} open_io failed: {err}", implementation.name))
        .into_parts();
    let payload = b"byte-io-ping\n";
    io.stdin
        .write_all(payload)
        .await
        .unwrap_or_else(|err| panic!("{} stdin write failed: {err}", implementation.name));
    io.stdin
        .flush()
        .await
        .unwrap_or_else(|err| panic!("{} stdin flush failed: {err}", implementation.name));

    let read = read_stdout(&mut io.stdout, payload.len()).await;
    assert_eq!(
        read, payload,
        "{} should round-trip bytes through stdin/stdout",
        implementation.name
    );

    manager.stop(&handle.id).await.unwrap();
}

pub(crate) async fn stdin_drop_closes_write_half(implementation: &SandboxImplementation) {
    let manager = SandboxManager::new(implementation.backend.clone());
    let handle = manager
        .create_running(implementation.byte_io_spec.clone())
        .await
        .unwrap_or_else(|err| {
            panic!(
                "{} create stdin-close sandbox failed: {err}",
                implementation.name
            )
        });

    let io = manager
        .open_io(&handle.id)
        .await
        .unwrap_or_else(|err| panic!("{} open_io failed: {err}", implementation.name))
        .into_parts();
    let mut stdin = io.stdin;
    let mut stdout = io.stdout;
    let _guard = io.guard;

    stdin.write_all(b"before-close\n").await.unwrap();
    stdin.flush().await.unwrap();
    assert_eq!(
        read_stdout(&mut stdout, b"before-close\n".len()).await,
        b"before-close\n"
    );
    drop_stdin(stdin);

    manager.stop(&handle.id).await.unwrap();
}

pub(crate) async fn reconnect_can_observe_and_stop(implementation: &SandboxImplementation) {
    let manager = SandboxManager::new(implementation.backend.clone());
    let handle = manager
        .create_running(implementation.long_running_spec.clone())
        .await
        .unwrap_or_else(|err| {
            panic!(
                "{} create reconnect sandbox failed: {err}",
                implementation.name
            )
        });

    let reconnected = SandboxManager::new((implementation.reconnect_backend)());
    eventually_status(&reconnected, &handle.id, SandboxStatus::Running).await;
    reconnected
        .stop(&handle.id)
        .await
        .unwrap_or_else(|err| panic!("{} reconnected stop failed: {err}", implementation.name));
    eventually_status(&reconnected, &handle.id, SandboxStatus::Gone).await;
}

pub(crate) async fn pause_blocks_read_write_until_resume(implementation: &SandboxImplementation) {
    let manager = SandboxManager::new(implementation.backend.clone());
    let handle = manager
        .create_running(implementation.byte_io_spec.clone())
        .await
        .unwrap_or_else(|err| {
            panic!(
                "{} create pause I/O sandbox failed: {err}",
                implementation.name
            )
        });

    manager.pause(&handle.id).await.unwrap();
    eventually_status(&manager, &handle.id, SandboxStatus::Suspended).await;

    assert!(
        manager.open_io(&handle.id).await.is_err(),
        "{} should reject opening I/O while paused",
        implementation.name
    );

    manager.resume(&handle.id).await.unwrap();
    eventually_status(&manager, &handle.id, SandboxStatus::Running).await;
    let mut io = manager.open_io(&handle.id).await.unwrap().into_parts();
    io.stdin.write_all(b"after-resume\n").await.unwrap();
    io.stdin.flush().await.unwrap();
    assert_eq!(
        read_stdout(&mut io.stdout, b"after-resume\n".len()).await,
        b"after-resume\n"
    );
    manager.stop(&handle.id).await.unwrap();
}

pub(crate) async fn missing_sandbox_operations_are_consistent(
    implementation: &SandboxImplementation,
) {
    let manager = SandboxManager::new(implementation.backend.clone());
    let missing = SandboxId::new(format!("missing-{}", implementation.name));

    assert_eq!(
        manager
            .status(&missing)
            .await
            .unwrap_or(SandboxStatus::Gone),
        SandboxStatus::Gone
    );
    assert!(
        manager.pause(&missing).await.is_err(),
        "{} should not pause a missing sandbox",
        implementation.name
    );
    assert!(
        manager.resume(&missing).await.is_err(),
        "{} should not resume a missing sandbox",
        implementation.name
    );
    assert!(
        manager.open_io(&missing).await.is_err(),
        "{} should not open I/O for a missing sandbox",
        implementation.name
    );
    manager.stop(&missing).await.unwrap_or_else(|err| {
        panic!(
            "{} stop should be idempotent for missing sandboxes: {err}",
            implementation.name
        )
    });
}

pub(crate) async fn failed_create_cleans_up_observed_resources(
    implementation: &SandboxImplementation,
) {
    let before = implementation
        .backend
        .list_observed()
        .await
        .unwrap_or_default()
        .len();
    assert!(
        implementation
            .backend
            .create(implementation.invalid_spec.clone())
            .await
            .is_err(),
        "{} invalid create should fail",
        implementation.name
    );
    eventually_observed_count_at_most(implementation.backend.clone(), before).await;
}

pub(crate) async fn env_secret_proxy_rewrites_https_request_before_receiver(
    implementation: &ProxyE2eImplementation,
) {
    let mut cleanup = ProxyE2eCleanup::new(implementation);
    let result = run_env_secret_proxy_e2e(implementation, &mut cleanup).await;
    cleanup.cleanup().await;
    result.unwrap_or_else(|err| panic!("{} proxy e2e failed: {err}", implementation.name));
}

async fn run_env_secret_proxy_e2e(
    implementation: &ProxyE2eImplementation,
    cleanup: &mut ProxyE2eCleanup,
) -> TestResult<()> {
    require_command("openssl")?;
    let temp = TempDir::new("centaur-sandbox-proxy-e2e")?;
    let certs = generate_proxy_e2e_certs(temp.path(), &implementation.receiver_host)?;
    let ca_cert_secret_name = implementation.ca_cert_secret_name.clone();
    let ca_key_secret_name = implementation.ca_key_secret_name.clone();
    let env_secret_name = implementation.env_secret_name.clone();

    create_secret(
        &implementation.client,
        &implementation.namespace,
        &ca_cert_secret_name,
        BTreeMap::from([("ca-cert.pem".to_owned(), certs.ca_cert.clone())]),
    )
    .await?;
    cleanup.secret(ca_cert_secret_name);
    create_secret(
        &implementation.client,
        &implementation.namespace,
        &ca_key_secret_name,
        BTreeMap::from([
            ("ca-cert.pem".to_owned(), certs.ca_cert.clone()),
            ("ca-key.pem".to_owned(), certs.ca_key.clone()),
        ]),
    )
    .await?;
    cleanup.secret(ca_key_secret_name);
    create_secret(
        &implementation.client,
        &implementation.namespace,
        &env_secret_name,
        BTreeMap::from([(
            PROXY_E2E_PLACEHOLDER.to_owned(),
            PROXY_E2E_REAL_SECRET.to_owned(),
        )]),
    )
    .await?;
    cleanup.secret(env_secret_name);

    let receiver_manager = SandboxManager::new(implementation.receiver_backend.clone());
    let receiver = receiver_manager
        .create_running(receiver_spec(
            &implementation.receiver_image,
            &certs.server_cert,
            &certs.server_key,
        ))
        .await?;
    cleanup.sandbox(implementation.receiver_backend.clone(), receiver.id.clone());
    create_receiver_service(implementation, &receiver.id).await?;
    cleanup.service(implementation.receiver_service_name.clone());
    let receiver_policy = create_receiver_ingress_policy(implementation, &receiver.id).await?;
    cleanup.network_policy(receiver_policy);

    let mut receiver_io = receiver_manager.open_io(&receiver.id).await?.into_parts();
    receiver_io.stdin.write_all(b"start\n").await?;
    receiver_io.stdin.flush().await?;
    read_until(
        &mut receiver_io.stdout,
        "RECEIVER_READY\n",
        Duration::from_secs(15),
    )
    .await?;
    wait_for_service_endpoint(
        &implementation.client,
        &implementation.namespace,
        &implementation.receiver_service_name,
        RECEIVER_PORT,
    )
    .await?;

    let sender_manager = SandboxManager::new(implementation.sender_backend.clone());
    let sender = sender_manager
        .create_running(sender_spec(
            &implementation.curl_image,
            &implementation.receiver_host,
        ))
        .await?;
    cleanup.sandbox(implementation.sender_backend.clone(), sender.id.clone());
    let mut sender_io = sender_manager.open_io(&sender.id).await?.into_parts();
    sender_io.stdin.write_all(b"start\n").await?;
    sender_io.stdin.flush().await?;
    let sender_output = read_until(
        &mut sender_io.stdout,
        "SENDER_DONE\n",
        Duration::from_secs(60),
    )
    .await?;
    if !sender_output.contains("ok") {
        let proxy_logs = proxy_logs_for_sandbox(implementation, &sender.id).await;
        return Err(
            format!(
                "sender did not receive the mock HTTPS response:\n{sender_output}\nproxy logs:\n{proxy_logs}"
            )
            .into(),
        );
    }
    if !sender_output.contains("SENDER_STATUS=0") {
        let proxy_logs = proxy_logs_for_sandbox(implementation, &sender.id).await;
        return Err(
            format!("sender curl failed:\n{sender_output}\nproxy logs:\n{proxy_logs}").into(),
        );
    }

    let receiver_output = read_until(
        &mut receiver_io.stdout,
        "REQUEST_END\n",
        Duration::from_secs(15),
    )
    .await?;
    if !receiver_output.contains(&format!("authorization: Bearer {PROXY_E2E_REAL_SECRET}"))
        && !receiver_output.contains(&format!("Authorization: Bearer {PROXY_E2E_REAL_SECRET}"))
    {
        return Err(format!(
            "receiver did not observe the env-backed real secret:\n{receiver_output}"
        )
        .into());
    }
    if receiver_output.contains(PROXY_E2E_PLACEHOLDER) {
        return Err(format!(
            "receiver observed the sandbox placeholder instead of the real secret:\n{receiver_output}"
        )
        .into());
    }
    if !receiver_output.contains("GET /capture HTTP/1.1") {
        return Err(format!(
            "receiver did not observe the expected HTTPS request:\n{receiver_output}"
        )
        .into());
    }

    Ok(())
}

async fn eventually_status<S>(manager: &SandboxManager<S>, id: &SandboxId, expected: SandboxStatus)
where
    S: centaur_sandbox_manager::DesiredStateStore,
{
    let mut latest = SandboxStatus::Gone;
    let result = timeout(Duration::from_secs(45), async {
        let mut ticks = interval(Duration::from_millis(250));
        loop {
            let status = manager.status(id).await.unwrap_or(SandboxStatus::Gone);
            if status == expected {
                return;
            }
            latest = status;
            ticks.tick().await;
        }
    })
    .await;

    assert!(
        result.is_ok(),
        "sandbox {} did not reach {expected:?}; latest status: {latest:?}",
        id.as_str()
    );
}

async fn eventually_observed_count_at_most(backend: Arc<dyn SandboxBackend>, expected_max: usize) {
    let mut latest = usize::MAX;
    let result = timeout(Duration::from_secs(45), async {
        let mut ticks = interval(Duration::from_millis(250));
        loop {
            let count = backend.list_observed().await.unwrap_or_default().len();
            if count <= expected_max {
                return;
            }
            latest = count;
            ticks.tick().await;
        }
    })
    .await;

    assert!(
        result.is_ok(),
        "observed sandbox count stayed above {expected_max}; latest count: {latest}"
    );
}

async fn read_stdout(stdout: &mut centaur_sandbox_core::SandboxRead, len: usize) -> Vec<u8> {
    let mut buf = vec![0; len];
    timeout(Duration::from_secs(5), stdout.read_exact(&mut buf))
        .await
        .expect("read stdout timed out")
        .expect("read stdout failed");
    buf
}

async fn read_until(
    stdout: &mut SandboxRead,
    marker: &str,
    duration: Duration,
) -> TestResult<String> {
    let marker = marker.as_bytes();
    let mut output = Vec::new();
    let result = timeout(duration, async {
        let mut buf = [0_u8; 1024];
        loop {
            let read = stdout.read(&mut buf).await?;
            if read == 0 {
                return Err(format!(
                    "stdout closed before marker {}; output:\n{}",
                    String::from_utf8_lossy(marker),
                    String::from_utf8_lossy(&output)
                )
                .into());
            }
            output.extend_from_slice(&buf[..read]);
            if output.windows(marker.len()).any(|window| window == marker) {
                return Ok(());
            }
            if output.len() > 128 * 1024 {
                return Err(format!(
                    "stdout exceeded 128KiB before marker {}; output:\n{}",
                    String::from_utf8_lossy(marker),
                    String::from_utf8_lossy(&output)
                )
                .into());
            }
        }
    })
    .await;

    match result {
        Ok(Ok(())) => Ok(String::from_utf8_lossy(&output).to_string()),
        Ok(Err(err)) => Err(err),
        Err(_) => Err(format!(
            "timed out waiting for marker {}; output:\n{}",
            String::from_utf8_lossy(marker),
            String::from_utf8_lossy(&output)
        )
        .into()),
    }
}

async fn wait_for_service_endpoint(
    client: &Client,
    namespace: &str,
    service_name: &str,
    port: i32,
) -> TestResult<()> {
    let endpoints: Api<Endpoints> = Api::namespaced(client.clone(), namespace);
    let mut latest = String::new();
    timeout(Duration::from_secs(15), async {
        let mut ticks = interval(Duration::from_millis(100));
        loop {
            match endpoints.get(service_name).await {
                Ok(endpoint) if endpoint_has_ready_port(&endpoint, port) => return Ok(()),
                Ok(endpoint) => latest = format!("{endpoint:?}"),
                Err(err) => latest = err.to_string(),
            }
            ticks.tick().await;
        }
    })
    .await
    .map_err(|_| {
        format!("service {service_name} did not publish a ready endpoint on port {port}: {latest}")
    })?
}

fn endpoint_has_ready_port(endpoints: &Endpoints, port: i32) -> bool {
    endpoints.subsets.as_ref().is_some_and(|subsets| {
        subsets.iter().any(|subset| {
            subset
                .addresses
                .as_ref()
                .is_some_and(|addresses| !addresses.is_empty())
                && subset.ports.as_ref().is_some_and(|ports| {
                    ports.iter().any(|endpoint_port| endpoint_port.port == port)
                })
        })
    })
}

fn drop_stdin(stdin: SandboxWrite) {
    drop(stdin);
}

fn receiver_spec(image: &str, server_cert: &str, server_key: &str) -> SandboxSpec {
    SandboxSpec::new(image)
        .command(["python3", "-u", "-c"])
        .args([RECEIVER_SCRIPT])
        .env("SERVER_CERT_PEM", server_cert)
        .env("SERVER_KEY_PEM", server_key)
}

fn sender_spec(image: &str, receiver_host: &str) -> SandboxSpec {
    let script = format!(
        r#"
set -u
read _start
set +e
response="$(curl --fail --silent --show-error \
  -H "Authorization: Bearer ${{{PROXY_E2E_PLACEHOLDER}}}" \
  -H "X-Test-Trace: sandbox-proxy-e2e" \
  'https://{receiver_host}/capture' 2>&1)"
status="$?"
printf 'SENDER_STATUS=%s\n' "$status"
printf '%s\n' "$response"
printf 'SENDER_DONE\n'
exit "$status"
"#
    );
    SandboxSpec::new(image)
        .command(["/bin/sh", "-lc"])
        .args([script])
}

const RECEIVER_SCRIPT: &str = r#"
import os
import socket
import ssl
import sys

sys.stdin.readline()

with open("/tmp/server.crt", "w", encoding="utf-8") as cert:
    cert.write(os.environ["SERVER_CERT_PEM"])
with open("/tmp/server.key", "w", encoding="utf-8") as key:
    key.write(os.environ["SERVER_KEY_PEM"])

context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain("/tmp/server.crt", "/tmp/server.key")
sock = socket.socket()
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("0.0.0.0", 443))
sock.listen(1)
sys.stdout.write("RECEIVER_READY\n")
sys.stdout.flush()

conn, _addr = sock.accept()
with context.wrap_socket(conn, server_side=True) as tls:
    request = b""
    while b"\r\n\r\n" not in request:
        chunk = tls.recv(4096)
        if not chunk:
            break
        request += chunk
        if len(request) > 16384:
            raise RuntimeError("request headers exceeded 16KiB")
    sys.stdout.write("REQUEST_BEGIN\n")
    sys.stdout.write(request.decode("iso-8859-1"))
    sys.stdout.write("\nREQUEST_END\n")
    sys.stdout.flush()
    tls.sendall(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok")
"#;

async fn proxy_logs_for_sandbox(
    implementation: &ProxyE2eImplementation,
    sandbox_id: &SandboxId,
) -> String {
    let pods: Api<Pod> = Api::namespaced(implementation.client.clone(), &implementation.namespace);
    let selector = format!(
        "centaur.ai/iron-proxy=true,centaur.ai/sandbox-id={}",
        sandbox_id.as_str()
    );
    let list = match pods.list(&ListParams::default().labels(&selector)).await {
        Ok(list) => list,
        Err(err) => return format!("failed to list proxy pods: {err}"),
    };
    let mut logs = String::new();
    for pod in list.items {
        let Some(name) = pod.metadata.name else {
            continue;
        };
        let params = LogParams {
            container: Some("iron-proxy".to_owned()),
            tail_lines: Some(200),
            ..LogParams::default()
        };
        match pods.logs(&name, &params).await {
            Ok(pod_logs) => {
                logs.push_str(&format!("== {name} ==\n{pod_logs}\n"));
            }
            Err(err) => {
                logs.push_str(&format!("== {name} ==\nfailed to read logs: {err}\n"));
            }
        }
    }
    if logs.is_empty() {
        format!("no proxy pods found for selector {selector}")
    } else {
        logs
    }
}

async fn create_receiver_service(
    implementation: &ProxyE2eImplementation,
    receiver_id: &SandboxId,
) -> TestResult<()> {
    let services: Api<Service> =
        Api::namespaced(implementation.client.clone(), &implementation.namespace);
    let _ = services
        .delete(
            &implementation.receiver_service_name,
            &DeleteParams::default(),
        )
        .await;
    services
        .create(
            &PostParams::default(),
            &Service {
                metadata: ObjectMeta {
                    name: Some(implementation.receiver_service_name.clone()),
                    labels: Some(BTreeMap::from([(
                        "centaur.ai/e2e".to_owned(),
                        "iron-proxy-env-secret".to_owned(),
                    )])),
                    ..ObjectMeta::default()
                },
                spec: Some(ServiceSpec {
                    selector: Some(BTreeMap::from([(
                        "centaur.ai/sandbox-id".to_owned(),
                        receiver_id.as_str().to_owned(),
                    )])),
                    ports: Some(vec![ServicePort {
                        name: Some("https".to_owned()),
                        port: 443,
                        protocol: Some("TCP".to_owned()),
                        target_port: Some(IntOrString::Int(RECEIVER_PORT)),
                        ..ServicePort::default()
                    }]),
                    type_: Some("ClusterIP".to_owned()),
                    ..ServiceSpec::default()
                }),
                ..Service::default()
            },
        )
        .await?;
    Ok(())
}

async fn create_receiver_ingress_policy(
    implementation: &ProxyE2eImplementation,
    receiver_id: &SandboxId,
) -> TestResult<String> {
    let policies: Api<NetworkPolicy> =
        Api::namespaced(implementation.client.clone(), &implementation.namespace);
    let name = format!("{}-ingress", implementation.receiver_service_name);
    let _ = policies.delete(&name, &DeleteParams::default()).await;
    policies
        .create(
            &PostParams::default(),
            &NetworkPolicy {
                metadata: ObjectMeta {
                    name: Some(name.clone()),
                    labels: Some(BTreeMap::from([(
                        "centaur.ai/e2e".to_owned(),
                        "iron-proxy-env-secret".to_owned(),
                    )])),
                    ..ObjectMeta::default()
                },
                spec: Some(NetworkPolicySpec {
                    pod_selector: Some(LabelSelector {
                        match_labels: Some(BTreeMap::from([(
                            "centaur.ai/sandbox-id".to_owned(),
                            receiver_id.as_str().to_owned(),
                        )])),
                        ..LabelSelector::default()
                    }),
                    policy_types: Some(vec!["Ingress".to_owned()]),
                    ingress: Some(vec![NetworkPolicyIngressRule {
                        from: Some(vec![NetworkPolicyPeer {
                            pod_selector: Some(LabelSelector {
                                match_labels: Some(BTreeMap::from([(
                                    "centaur.ai/iron-proxy".to_owned(),
                                    "true".to_owned(),
                                )])),
                                ..LabelSelector::default()
                            }),
                            ..NetworkPolicyPeer::default()
                        }]),
                        ports: Some(vec![NetworkPolicyPort {
                            port: Some(IntOrString::Int(RECEIVER_PORT)),
                            protocol: Some("TCP".to_owned()),
                            ..NetworkPolicyPort::default()
                        }]),
                    }]),
                    ..NetworkPolicySpec::default()
                }),
            },
        )
        .await?;
    Ok(name)
}

async fn create_secret(
    client: &Client,
    namespace: &str,
    name: &str,
    string_data: BTreeMap<String, String>,
) -> TestResult<()> {
    let secrets: Api<Secret> = Api::namespaced(client.clone(), namespace);
    let _ = secrets.delete(name, &DeleteParams::default()).await;
    secrets
        .create(
            &PostParams::default(),
            &Secret {
                metadata: ObjectMeta {
                    name: Some(name.to_owned()),
                    labels: Some(BTreeMap::from([(
                        "centaur.ai/e2e".to_owned(),
                        "iron-proxy-env-secret".to_owned(),
                    )])),
                    ..ObjectMeta::default()
                },
                string_data: Some(string_data),
                type_: Some("Opaque".to_owned()),
                ..Secret::default()
            },
        )
        .await?;
    Ok(())
}

struct ProxyE2eCleanup {
    client: Client,
    namespace: String,
    sandboxes: Vec<(Arc<dyn SandboxBackend>, SandboxId)>,
    services: Vec<String>,
    network_policies: Vec<String>,
    secrets: Vec<String>,
}

impl ProxyE2eCleanup {
    fn new(implementation: &ProxyE2eImplementation) -> Self {
        Self {
            client: implementation.client.clone(),
            namespace: implementation.namespace.clone(),
            sandboxes: Vec::new(),
            services: Vec::new(),
            network_policies: Vec::new(),
            secrets: Vec::new(),
        }
    }

    fn sandbox(&mut self, backend: Arc<dyn SandboxBackend>, id: SandboxId) {
        self.sandboxes.push((backend, id));
    }

    fn service(&mut self, name: String) {
        self.services.push(name);
    }

    fn network_policy(&mut self, name: String) {
        self.network_policies.push(name);
    }

    fn secret(&mut self, name: String) {
        self.secrets.push(name);
    }

    async fn cleanup(&mut self) {
        for (backend, id) in self.sandboxes.drain(..).rev() {
            let manager = SandboxManager::new(backend);
            let _ = manager.stop(&id).await;
        }
        let services: Api<Service> = Api::namespaced(self.client.clone(), &self.namespace);
        for name in self.services.drain(..).rev() {
            let _ = services.delete(&name, &DeleteParams::default()).await;
        }
        let network_policies: Api<NetworkPolicy> =
            Api::namespaced(self.client.clone(), &self.namespace);
        for name in self.network_policies.drain(..).rev() {
            let _ = network_policies
                .delete(&name, &DeleteParams::default())
                .await;
        }
        let secrets: Api<Secret> = Api::namespaced(self.client.clone(), &self.namespace);
        for name in self.secrets.drain(..).rev() {
            let _ = secrets.delete(&name, &DeleteParams::default()).await;
        }
    }
}

struct ProxyE2eCerts {
    ca_cert: String,
    ca_key: String,
    server_cert: String,
    server_key: String,
}

fn generate_proxy_e2e_certs(temp: &Path, receiver_host: &str) -> TestResult<ProxyE2eCerts> {
    let ca_key = temp.join("ca-key.pem");
    let ca_cert = temp.join("ca-cert.pem");
    run_command(
        Command::new("openssl")
            .args([
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-sha256",
                "-days",
                "1",
                "-subj",
                "/CN=centaur-sandbox-proxy-e2e-ca",
                "-addext",
                "basicConstraints=critical,CA:TRUE",
                "-addext",
                "keyUsage=critical,keyCertSign,cRLSign",
                "-keyout",
            ])
            .arg(&ca_key)
            .arg("-out")
            .arg(&ca_cert),
        "generate proxy e2e CA",
    )?;

    let server_key = temp.join("server-key.pem");
    let server_csr = temp.join("server.csr");
    let server_cert = temp.join("server-cert.pem");
    let ext = temp.join("server.ext");
    let service_name = receiver_host.split('.').next().unwrap_or(receiver_host);
    let service_namespace = receiver_host
        .split('.')
        .nth(1)
        .map(|namespace| format!("{service_name}.{namespace}"));
    let mut dns_names = vec![service_name.to_owned(), receiver_host.to_owned()];
    if let Some(service_namespace) = service_namespace {
        dns_names.push(service_namespace);
    }
    dns_names.push(format!("{receiver_host}.cluster.local"));
    dns_names.sort();
    dns_names.dedup();
    fs::write(
        &ext,
        [
            "basicConstraints=critical,CA:FALSE".to_owned(),
            "keyUsage=critical,digitalSignature,keyEncipherment".to_owned(),
            "extendedKeyUsage=serverAuth".to_owned(),
            format!(
                "subjectAltName={}",
                dns_names
                    .into_iter()
                    .map(|name| format!("DNS:{name}"))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            String::new(),
        ]
        .join("\n"),
    )?;
    run_command(
        Command::new("openssl")
            .args([
                "req",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-sha256",
                "-subj",
                &format!("/CN={receiver_host}"),
                "-keyout",
            ])
            .arg(&server_key)
            .arg("-out")
            .arg(&server_csr),
        "generate proxy e2e receiver CSR",
    )?;
    run_command(
        Command::new("openssl")
            .args(["x509", "-req", "-in"])
            .arg(&server_csr)
            .arg("-CA")
            .arg(&ca_cert)
            .arg("-CAkey")
            .arg(&ca_key)
            .args(["-CAcreateserial", "-out"])
            .arg(&server_cert)
            .args(["-days", "1", "-sha256", "-extfile"])
            .arg(&ext),
        "sign proxy e2e receiver certificate",
    )?;

    Ok(ProxyE2eCerts {
        ca_cert: fs::read_to_string(ca_cert)?,
        ca_key: fs::read_to_string(ca_key)?,
        server_cert: fs::read_to_string(server_cert)?,
        server_key: fs::read_to_string(server_key)?,
    })
}

fn require_command(name: &str) -> TestResult<()> {
    match Command::new(name).arg("--version").output() {
        Ok(_) => Ok(()),
        Err(err) if err.kind() == ErrorKind::NotFound => {
            Err(format!("{name} is required for this ignored integration test").into())
        }
        Err(err) => Err(format!("failed to execute {name}: {err}").into()),
    }
}

fn run_command(command: &mut Command, label: &str) -> TestResult<()> {
    let output = command.output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{label} failed: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
        .into())
    }
}

fn unique_k8s_name(prefix: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let sequence = NEXT_K8S_NAME.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{millis}-{sequence}", std::process::id())
}

fn use_unique_warm_pool(config: &mut AgentSandboxConfig, prefix: &str) {
    let pool_name = unique_k8s_name(prefix);
    let template_name = format!("{pool_name}-template");
    config.warm_pool = SandboxWarmPoolConfig::new(pool_name, template_name);
}

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(prefix: &str) -> TestResult<Self> {
        let path = std::env::temp_dir().join(unique_k8s_name(prefix));
        fs::create_dir_all(&path)?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn local_implementation() -> SandboxImplementation {
    let backend = Arc::new(LocalSandboxBackend::new());
    let reconnect_backend = backend.clone();
    SandboxImplementation {
        name: "local",
        backend,
        reconnect_backend: Arc::new(move || reconnect_backend.clone()),
        long_running_spec: shell_spec("sleep 3600"),
        short_lived_spec: shell_spec("sleep 0.02"),
        byte_io_spec: SandboxSpec::new("/bin/cat"),
        invalid_spec: SandboxSpec::new("/definitely-not-a-centaur-command"),
    }
}

async fn agent_k8s_implementation() -> SandboxImplementation {
    let args = E2eArgs::from_env();
    let (client, namespace) = agent_k8s_client_and_namespace(&args).await;
    let image = args.sandbox_e2e_k8s_image;
    let mut config = AgentSandboxConfig::new(namespace);
    config.ready_timeout = Duration::from_secs(90);
    use_unique_warm_pool(&mut config, "sandbox-e2e");
    let backend = Arc::new(AgentSandboxBackend::new(client.clone(), config.clone()));

    SandboxImplementation {
        name: "agent-k8s",
        backend,
        reconnect_backend: Arc::new(move || {
            Arc::new(AgentSandboxBackend::new(client.clone(), config.clone()))
        }),
        long_running_spec: k8s_shell_spec(&image, "sleep 3600"),
        short_lived_spec: k8s_shell_spec(&image, "sleep 1"),
        byte_io_spec: k8s_shell_spec(&image, "cat"),
        invalid_spec: SandboxSpec::new(image).command(["/definitely-not-a-centaur-command"]),
    }
}

async fn agent_k8s_proxy_implementation() -> ProxyE2eImplementation {
    let args = E2eArgs::from_env();
    let (client, namespace) = agent_k8s_client_and_namespace(&args).await;
    let name = unique_k8s_name("proxy-e2e");
    let ca_cert_secret_name = format!("{name}-ca-cert");
    let ca_key_secret_name = format!("{name}-ca-key");
    let env_secret_name = format!("{name}-env");
    let receiver_service_name = format!("{name}-recv");
    let receiver_host = format!("{receiver_service_name}.{namespace}.svc");

    let mut receiver_config = AgentSandboxConfig::new(namespace.clone());
    receiver_config.ready_timeout = Duration::from_secs(120);
    use_unique_warm_pool(&mut receiver_config, "proxy-e2e-receiver");

    let mut sender_config = AgentSandboxConfig::new(namespace.clone());
    sender_config.ready_timeout = Duration::from_secs(120);
    use_unique_warm_pool(&mut sender_config, "proxy-e2e-sender");
    let mut iron_proxy = IronProxyPodConfig::new(
        args.sandbox_e2e_iron_proxy_image,
        ca_cert_secret_name.clone(),
        ca_key_secret_name.clone(),
    );
    iron_proxy.image_pull_policy = Some(args.sandbox_e2e_iron_proxy_image_pull_policy);
    iron_proxy.source_policy = SourcePolicy::env();
    iron_proxy.env_from_secret_names = vec![env_secret_name.clone()];
    iron_proxy.extra_env.insert(
        "SSL_CERT_FILE".to_owned(),
        "/etc/iron-proxy-ca/ca-cert.pem".to_owned(),
    );
    iron_proxy.fragments = vec![
        load_fragment_str(&format!(
            r#"
transforms:
  - name: secrets
    config:
      secrets:
        - replace:
            proxy_value: {PROXY_E2E_PLACEHOLDER}
            match_headers: ["Authorization"]
          rules: [{{ host: {receiver_host} }}]
"#
        ))
        .expect("load proxy e2e fragment"),
    ];
    sender_config.iron_proxy = Some(iron_proxy);

    ProxyE2eImplementation {
        name: "agent-k8s",
        client: client.clone(),
        namespace,
        receiver_backend: Arc::new(AgentSandboxBackend::new(client.clone(), receiver_config)),
        sender_backend: Arc::new(AgentSandboxBackend::new(client, sender_config)),
        receiver_image: args.sandbox_e2e_receiver_image,
        curl_image: args.sandbox_e2e_curl_image,
        receiver_host,
        receiver_service_name,
        ca_cert_secret_name,
        ca_key_secret_name,
        env_secret_name,
    }
}

async fn agent_k8s_client_and_namespace(args: &E2eArgs) -> (Client, String) {
    let context = args
        .sandbox_e2e_k8s_context
        .clone()
        .or_else(|| args.kube_context.clone())
        .unwrap_or_else(|| "kind-centaur-api-rs-e2e".to_owned());
    let namespace = args
        .sandbox_e2e_k8s_namespace
        .clone()
        .or_else(|| args.kube_namespace.clone())
        .unwrap_or_else(|| "centaur-sandbox-e2e".to_owned());

    let kube_config = Config::from_kubeconfig(&KubeConfigOptions {
        context: Some(context),
        ..KubeConfigOptions::default()
    })
    .await
    .expect("load e2e kube config");
    let client = Client::try_from(kube_config).expect("create e2e kube client");
    (client, namespace)
}

fn validate_requested_implementations(args: &E2eArgs) {
    if args.sandbox_e2e_impls.trim() == "all" {
        return;
    }
    for name in args.requested_implementation_names() {
        assert!(
            ALL_IMPLEMENTATIONS.contains(&name),
            "unknown sandbox e2e implementation {name:?}"
        );
    }
}

#[derive(Debug, Parser)]
struct E2eArgs {
    #[arg(long, env = "SANDBOX_E2E_IMPLS", default_value = "all")]
    sandbox_e2e_impls: String,
    #[arg(long, env = "SANDBOX_E2E_K8S_CONTEXT")]
    sandbox_e2e_k8s_context: Option<String>,
    #[arg(long, env = "KUBE_CONTEXT")]
    kube_context: Option<String>,
    #[arg(long, env = "SANDBOX_E2E_K8S_NAMESPACE")]
    sandbox_e2e_k8s_namespace: Option<String>,
    #[arg(long, env = "KUBE_NAMESPACE")]
    kube_namespace: Option<String>,
    #[arg(long, env = "SANDBOX_E2E_K8S_IMAGE", default_value = "busybox:1.36")]
    sandbox_e2e_k8s_image: String,
    #[arg(
        long,
        env = "SANDBOX_E2E_IRON_PROXY_IMAGE",
        default_value = "centaur-iron-proxy:latest"
    )]
    sandbox_e2e_iron_proxy_image: String,
    #[arg(
        long,
        env = "SANDBOX_E2E_IRON_PROXY_IMAGE_PULL_POLICY",
        default_value = "IfNotPresent"
    )]
    sandbox_e2e_iron_proxy_image_pull_policy: String,
    #[arg(
        long,
        env = "SANDBOX_E2E_RECEIVER_IMAGE",
        default_value = "python:3.12-alpine"
    )]
    sandbox_e2e_receiver_image: String,
    #[arg(
        long,
        env = "SANDBOX_E2E_CURL_IMAGE",
        default_value = "curlimages/curl:8.11.1"
    )]
    sandbox_e2e_curl_image: String,
}

impl E2eArgs {
    fn from_env() -> Self {
        Self::parse_from(["centaur-sandbox-e2e"])
    }

    fn includes_implementation(&self, name: &str) -> bool {
        if self.sandbox_e2e_impls.trim() == "all" {
            return true;
        }
        self.requested_implementation_names()
            .into_iter()
            .any(|requested| requested == name)
    }

    fn requested_implementation_names(&self) -> Vec<&str> {
        self.sandbox_e2e_impls
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .collect()
    }
}

fn shell_spec(script: &str) -> SandboxSpec {
    SandboxSpec::new("/bin/sh")
        .command(["/bin/sh", "-lc"])
        .args([script])
}

fn k8s_shell_spec(image: &str, script: &str) -> SandboxSpec {
    SandboxSpec::new(image)
        .command(["/bin/sh", "-lc"])
        .args([script])
}
