use std::collections::BTreeMap;

use clap::{Args as ClapArgs, ValueEnum};

#[derive(Debug, ClapArgs)]
pub(super) struct HarnessAuthArgs {
    #[arg(long = "codex-auth-mode", env = "CODEX_AUTH_MODE")]
    codex: Option<HarnessAuthMode>,
    #[arg(long = "claude-code-auth-mode", env = "CLAUDE_CODE_AUTH_MODE")]
    claude_code: Option<HarnessAuthMode>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum HarnessAuthMode {
    #[value(name = "api_key")]
    ApiKey,
    #[value(name = "access_token")]
    AccessToken,
}

impl HarnessAuthMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::ApiKey => "api_key",
            Self::AccessToken => "access_token",
        }
    }
}

impl HarnessAuthArgs {
    pub(super) fn codex_auth_mode(&self) -> Option<String> {
        self.codex.map(|mode| mode.as_str().to_owned())
    }

    pub(super) fn claude_code_auth_mode(&self) -> Option<String> {
        self.claude_code.map(|mode| mode.as_str().to_owned())
    }

    pub(super) fn proxy_modes(&self) -> BTreeMap<String, String> {
        [
            self.codex_auth_mode()
                .map(|mode| ("codex".to_owned(), mode)),
            self.claude_code_auth_mode()
                .map(|mode| ("claude-code".to_owned(), mode)),
        ]
        .into_iter()
        .flatten()
        .collect()
    }
}
