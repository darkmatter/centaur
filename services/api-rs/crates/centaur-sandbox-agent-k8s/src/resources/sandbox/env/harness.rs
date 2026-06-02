use std::collections::BTreeMap;

use centaur_sandbox_core::{CredentialProfile, CredentialRequest};

pub(super) fn harness_auth_env(credentials: &[CredentialRequest]) -> BTreeMap<String, String> {
    credentials
        .iter()
        .filter_map(|credential| {
            let name = match credential.profile {
                CredentialProfile::Codex => "CODEX_AUTH_MODE",
                CredentialProfile::ClaudeCode => "CLAUDE_CODE_AUTH_MODE",
                CredentialProfile::Amp => return None,
            };
            credential
                .auth_mode
                .map(|mode| (name.to_owned(), mode.as_str().to_owned()))
        })
        .collect()
}
