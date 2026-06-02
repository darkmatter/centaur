use std::sync::Arc;

use centaur_sandbox_core::{DesiredSandboxState, SandboxId, SandboxSpec, SandboxStatus};
use centaur_sandbox_manager::{DriftReason, SandboxManager};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    time::{Duration, Instant, sleep, timeout},
};

use crate::LocalSandboxBackend;

#[tokio::test]
async fn local_backend_round_trips_bytes_through_manager() {
    let backend = Arc::new(LocalSandboxBackend::new());
    let manager = SandboxManager::new(backend);
    let handle = manager.create_running(cat_spec()).await.unwrap();
    let mut io = manager.open_io(&handle.id).await.unwrap().into_parts();

    io.stdin.write_all(b"ping\n").await.unwrap();
    io.stdin.flush().await.unwrap();
    let mut read = vec![0; b"ping\n".len()];
    timeout(Duration::from_secs(1), io.stdout.read_exact(&mut read))
        .await
        .expect("stdout read timed out")
        .unwrap();

    assert_eq!(read, b"ping\n");
    manager.stop(&handle.id).await.unwrap();
}

#[tokio::test]
async fn local_backend_open_io_write_is_not_blocked_by_pending_stdout_read() {
    let backend = Arc::new(LocalSandboxBackend::new());
    let manager = SandboxManager::new(backend);
    let handle = manager.create_running(cat_spec()).await.unwrap();
    let io = manager.open_io(&handle.id).await.unwrap().into_parts();
    let mut stdin = io.stdin;
    let mut stdout = io.stdout;
    let _guard = io.guard;

    let pending_read = tokio::spawn(async move {
        let mut read = vec![0; b"ping\n".len()];
        stdout.read_exact(&mut read).await.unwrap();
        read
    });
    sleep(Duration::from_millis(50)).await;

    timeout(Duration::from_millis(100), async {
        stdin.write_all(b"ping\n").await.unwrap();
        stdin.flush().await.unwrap();
    })
    .await
    .expect("stdin write should not wait for a stdout read timeout");

    assert_eq!(pending_read.await.unwrap(), b"ping\n");
    manager.stop(&handle.id).await.unwrap();
}

#[tokio::test]
async fn local_backend_pause_resume_updates_runtime_and_desired_state() {
    let backend = Arc::new(LocalSandboxBackend::new());
    let manager = SandboxManager::new(backend);
    let handle = manager.create_running(cat_spec()).await.unwrap();

    manager.pause(&handle.id).await.unwrap();
    assert_eq!(
        manager.status(&handle.id).await.unwrap(),
        SandboxStatus::Suspended
    );
    assert!(matches!(
        manager.desired_state(&handle.id),
        Some(DesiredSandboxState::Suspended(_))
    ));

    manager.resume(&handle.id).await.unwrap();
    assert_eq!(
        manager.status(&handle.id).await.unwrap(),
        SandboxStatus::Running
    );
    assert!(matches!(
        manager.desired_state(&handle.id),
        Some(DesiredSandboxState::Running(_))
    ));

    manager.stop(&handle.id).await.unwrap();
}

#[tokio::test]
async fn local_backend_reports_unexpected_process_exit_to_manager() {
    let backend = Arc::new(LocalSandboxBackend::new());
    let manager = SandboxManager::new(backend);
    let handle = manager.create_running(short_lived_spec()).await.unwrap();

    wait_for_status(&manager, &handle.id, SandboxStatus::Stopped).await;
    assert_eq!(
        manager.reconcile_one(&handle.id).await.unwrap(),
        centaur_sandbox_manager::ReconcileOutcome::Drift(DriftReason::MissingWhileRunning)
    );
    manager.stop(&handle.id).await.unwrap();
}

fn cat_spec() -> SandboxSpec {
    SandboxSpec::new("/bin/cat")
}

fn short_lived_spec() -> SandboxSpec {
    SandboxSpec::new("/bin/sh")
        .command(["/bin/sh", "-lc"])
        .args(["sleep 0.02"])
}

async fn wait_for_status(manager: &SandboxManager, id: &SandboxId, expected: SandboxStatus) {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let actual = manager.status(id).await.unwrap();
        if actual == expected {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {id:?} to become {expected:?}; latest status: {actual:?}"
        );
        sleep(Duration::from_millis(25)).await;
    }
}
