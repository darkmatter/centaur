use std::process::Stdio;

use centaur_sandbox_core::{
    SandboxError, SandboxId, SandboxIo, SandboxRead, SandboxResult, SandboxSpec, SandboxStatus,
    SandboxWrite,
};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};

pub(crate) struct LocalSandbox {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Option<ChildStdout>,
    stderr: Option<ChildStderr>,
    status: SandboxStatus,
}

impl LocalSandbox {
    pub(crate) async fn spawn(spec: &SandboxSpec) -> SandboxResult<Self> {
        let (program, args) = command_parts(spec)?;
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(working_dir) = &spec.working_dir {
            command.current_dir(working_dir);
        }
        for env in &spec.env {
            command.env(&env.name, &env.value);
        }

        let mut child = command.spawn().map_err(|err| {
            SandboxError::Backend(format!("failed to spawn local sandbox: {err}"))
        })?;

        Ok(Self {
            stdin: child.stdin.take(),
            stdout: child.stdout.take(),
            stderr: child.stderr.take(),
            child,
            status: SandboxStatus::Running,
        })
    }

    pub(crate) async fn open_io(&mut self, id: &SandboxId) -> SandboxResult<SandboxIo> {
        let status = self.status().await?;
        if !status.can_open_io() {
            return Err(SandboxError::NotReady(format!(
                "local sandbox {} is {:?}",
                id.as_str(),
                status
            )));
        }

        let stdin = self
            .stdin
            .take()
            .ok_or_else(|| SandboxError::Io("stdin is already open or closed".to_owned()))?;
        let stdout = self
            .stdout
            .take()
            .ok_or_else(|| SandboxError::Io("stdout is already open or closed".to_owned()))?;
        let stderr = self
            .stderr
            .take()
            .ok_or_else(|| SandboxError::Io("stderr is already open or closed".to_owned()))?;
        Ok(SandboxIo::new(
            Box::pin(stdin) as SandboxWrite,
            Box::pin(stdout) as SandboxRead,
            Box::pin(stderr) as SandboxRead,
        ))
    }

    pub(crate) async fn status(&mut self) -> SandboxResult<SandboxStatus> {
        match self
            .child
            .try_wait()
            .map_err(|err| SandboxError::Backend(format!("failed to poll local sandbox: {err}")))?
        {
            Some(_) => {
                self.status = SandboxStatus::Stopped;
                Ok(SandboxStatus::Stopped)
            }
            None if matches!(self.status, SandboxStatus::Suspended) => Ok(SandboxStatus::Suspended),
            None => {
                self.status = SandboxStatus::Running;
                Ok(SandboxStatus::Running)
            }
        }
    }

    pub(crate) async fn stop(&mut self) -> SandboxResult<()> {
        if !self.status.is_terminal() {
            let _ = self.child.kill().await;
            let _ = self.child.wait().await;
        }
        self.status = SandboxStatus::Stopped;
        Ok(())
    }

    pub(crate) async fn pause(&mut self) -> SandboxResult<()> {
        send_signal(&self.child, "STOP").await?;
        self.status = SandboxStatus::Suspended;
        Ok(())
    }

    pub(crate) async fn resume(&mut self) -> SandboxResult<()> {
        send_signal(&self.child, "CONT").await?;
        self.status = SandboxStatus::Running;
        Ok(())
    }
}

fn command_parts(spec: &SandboxSpec) -> SandboxResult<(&str, Vec<&str>)> {
    if let Some(command) = &spec.command {
        let (program, args) = command
            .split_first()
            .ok_or_else(|| SandboxError::InvalidSpec("command is empty".to_owned()))?;
        let mut combined_args = args.iter().map(String::as_str).collect::<Vec<_>>();
        combined_args.extend(spec.args.iter().map(String::as_str));
        return Ok((program.as_str(), combined_args));
    }

    Ok((
        spec.image.as_str(),
        spec.args.iter().map(String::as_str).collect(),
    ))
}

async fn send_signal(child: &Child, signal: &str) -> SandboxResult<()> {
    let Some(pid) = child.id() else {
        return Err(SandboxError::NotReady(
            "local process has no pid".to_owned(),
        ));
    };

    let status = Command::new("kill")
        .arg(format!("-{signal}"))
        .arg(pid.to_string())
        .status()
        .await
        .map_err(|err| SandboxError::Backend(format!("failed to send SIG{signal}: {err}")))?;

    if status.success() {
        Ok(())
    } else {
        Err(SandboxError::Backend(format!(
            "kill -{signal} {pid} exited with {status}"
        )))
    }
}
