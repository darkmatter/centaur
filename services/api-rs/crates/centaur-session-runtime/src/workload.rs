use centaur_sandbox_core::{CredentialProfile, HarnessAuthModes, SandboxSpec};
use centaur_session_core::{HarnessType, ThreadKey};

#[derive(Clone, Debug)]
pub enum SandboxWorkloadMode {
    MockAppServer { image: String },
    CodexAppServer(CodexAppServerWorkload),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerWorkload {
    pub image: String,
    pub centaur_api_url: String,
    pub centaur_api_key: Option<String>,
    pub auth_modes: HarnessAuthModes,
    pub passthrough_env: Vec<(String, String)>,
}

impl SandboxWorkloadMode {
    pub fn mock_app_server(image: impl Into<String>) -> Self {
        Self::MockAppServer {
            image: image.into(),
        }
    }

    pub fn codex_app_server(workload: CodexAppServerWorkload) -> Self {
        Self::CodexAppServer(workload)
    }

    pub(crate) fn spec(&self, thread_key: &ThreadKey, harness_type: &HarnessType) -> SandboxSpec {
        match self {
            Self::MockAppServer { image } => SandboxSpec::new(image)
                .command(["/bin/sh", "-lc"])
                .args([mock_app_server_script()]),
            Self::CodexAppServer(workload) => workload.spec(thread_key, harness_type),
        }
    }
}

impl CodexAppServerWorkload {
    fn spec(&self, thread_key: &ThreadKey, harness_type: &HarnessType) -> SandboxSpec {
        let credential_profile = credential_profile_for(harness_type);
        let mut spec = SandboxSpec::new(&self.image)
            .env("CENTAUR_THREAD_KEY", thread_key.as_str())
            .env("CENTAUR_API_URL", &self.centaur_api_url)
            .credential(
                credential_profile,
                self.auth_modes.mode_for(credential_profile),
            );
        if let Some(api_key) = &self.centaur_api_key {
            spec = spec.env("CENTAUR_API_KEY", api_key);
        }
        for (name, value) in &self.passthrough_env {
            spec = spec.env(name, value);
        }
        spec
    }
}

fn credential_profile_for(harness_type: &HarnessType) -> CredentialProfile {
    match harness_type {
        HarnessType::Codex => CredentialProfile::Codex,
        HarnessType::Amp => CredentialProfile::Amp,
        HarnessType::ClaudeCode => CredentialProfile::ClaudeCode,
    }
}

fn mock_app_server_script() -> &'static str {
    r#"while IFS= read -r line; do
printf '%s\n' '{"type":"system","subtype":"wrapper_heartbeat","phase":"startup"}'
sleep 0.2
printf '%s\n' '{"type":"system","subtype":"wrapper_heartbeat","phase":"app_server_started"}'
sleep 0.2
printf '%s\n' '{"type":"thread.started","thread_id":"mock-codex-thread"}'
sleep 0.2
turn_index=1
while [ "$turn_index" -le 3 ]; do
  turn_id="mock-turn-$turn_index"
  printf '{"type":"turn.started","turn_id":"%s"}\n' "$turn_id"
  sleep 0.2
  printf '{"type":"item.agentMessage.delta","turnId":"%s","session_id":"mock-codex-thread","delta":"PONG %s"}\n' "$turn_id" "$turn_index"
  sleep 0.2
  printf '{"type":"turn.completed","turn":{"id":"%s"},"usage":{"input_tokens":0,"output_tokens":1}}\n' "$turn_id"
  sleep 0.2
  turn_index=$((turn_index + 1))
done
done"#
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use centaur_sandbox_core::{CredentialRequest, HarnessAuthMode};

    #[test]
    fn codex_app_server_declares_credential_profile() {
        let thread_key = ThreadKey::parse("cli:test").unwrap();
        let spec = SandboxWorkloadMode::codex_app_server(CodexAppServerWorkload {
            image: "centaur-agent:test".to_owned(),
            centaur_api_url: "http://api:8000".to_owned(),
            centaur_api_key: None,
            auth_modes: HarnessAuthModes::new(
                Some(HarnessAuthMode::AccessToken),
                Some(HarnessAuthMode::ApiKey),
            ),
            passthrough_env: vec![("NO_PROXY".to_owned(), "api".to_owned())],
        })
        .spec(&thread_key, &HarnessType::Codex);
        let env = spec
            .env
            .iter()
            .map(|item| (item.name.as_str(), item.value.as_str()))
            .collect::<HashMap<_, _>>();

        assert_eq!(env["CENTAUR_THREAD_KEY"], "cli:test");
        assert_eq!(env["CENTAUR_API_URL"], "http://api:8000");
        assert!(!env.contains_key("CODEX_AUTH_MODE"));
        assert!(!env.contains_key("CLAUDE_CODE_AUTH_MODE"));
        assert_eq!(env["NO_PROXY"], "api");
        assert_eq!(
            spec.credentials,
            vec![CredentialRequest {
                profile: CredentialProfile::Codex,
                auth_mode: Some(HarnessAuthMode::AccessToken),
            }]
        );
    }
}
