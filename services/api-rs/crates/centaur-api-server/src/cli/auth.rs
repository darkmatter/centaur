use std::collections::BTreeMap;

use clap::Args as ClapArgs;

#[derive(Debug, ClapArgs)]
pub(super) struct HarnessAuthArgs {
    #[arg(long = "codex-auth-mode", env = "CODEX_AUTH_MODE")]
    codex: Option<String>,
    #[arg(long = "claude-code-auth-mode", env = "CLAUDE_CODE_AUTH_MODE")]
    claude_code: Option<String>,
}

impl HarnessAuthArgs {
    pub(super) fn insert_app_server_env(&self, values: &mut BTreeMap<String, String>) {
        if let Some(value) = &self.claude_code {
            values.insert("CLAUDE_CODE_AUTH_MODE".to_owned(), value.clone());
        }
        if let Some(value) = &self.codex {
            values.insert("CODEX_AUTH_MODE".to_owned(), value.clone());
        }
    }

    pub(super) fn proxy_modes(&self) -> BTreeMap<String, String> {
        [
            self.codex.clone().map(|mode| ("codex".to_owned(), mode)),
            self.claude_code
                .clone()
                .map(|mode| ("claude-code".to_owned(), mode)),
        ]
        .into_iter()
        .flatten()
        .collect()
    }
}
