use serde::{Deserialize, Serialize};
use strum::{AsRefStr, EnumString};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, AsRefStr, EnumString)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum CredentialProfile {
    Codex,
    Amp,
    ClaudeCode,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CredentialRequest {
    pub profile: CredentialProfile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_mode: Option<HarnessAuthMode>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessAuthModes {
    pub codex: Option<HarnessAuthMode>,
    pub claude_code: Option<HarnessAuthMode>,
}

impl HarnessAuthModes {
    pub fn mode_for(&self, profile: CredentialProfile) -> Option<HarnessAuthMode> {
        match profile {
            CredentialProfile::Codex => self.codex,
            CredentialProfile::ClaudeCode => self.claude_code,
            CredentialProfile::Amp => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, AsRefStr, EnumString)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum HarnessAuthMode {
    ApiKey,
    AccessToken,
}
