mod credential;
mod env;
mod mount;
mod resources;

use serde::{Deserialize, Serialize};

pub use credential::{CredentialProfile, CredentialRequest, HarnessAuthMode, HarnessAuthModes};
pub use env::EnvVar;
pub use mount::{Mount, MountKind};
pub use resources::ResourceLimits;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SandboxSpec {
    pub image: String,
    pub command: Option<Vec<String>>,
    pub args: Vec<String>,
    pub env: Vec<EnvVar>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub credentials: Vec<CredentialRequest>,
    pub working_dir: Option<String>,
    pub mounts: Vec<Mount>,
    pub resources: Option<ResourceLimits>,
}

impl SandboxSpec {
    pub fn new(image: impl Into<String>) -> Self {
        Self {
            image: image.into(),
            command: None,
            args: Vec::new(),
            env: Vec::new(),
            credentials: Vec::new(),
            working_dir: None,
            mounts: Vec::new(),
            resources: None,
        }
    }

    pub fn command(mut self, command: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.command = Some(command.into_iter().map(Into::into).collect());
        self
    }

    pub fn args(mut self, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.args = args.into_iter().map(Into::into).collect();
        self
    }

    pub fn env(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.push(EnvVar::new(name, value));
        self
    }

    pub fn credential_profile(self, profile: CredentialProfile) -> Self {
        self.credential(profile, None)
    }

    pub fn credential(
        mut self,
        profile: CredentialProfile,
        auth_mode: Option<HarnessAuthMode>,
    ) -> Self {
        self.upsert_credential(CredentialRequest { profile, auth_mode });
        self
    }

    pub fn working_dir(mut self, working_dir: impl Into<String>) -> Self {
        self.working_dir = Some(working_dir.into());
        self
    }

    pub fn mount(mut self, mount: Mount) -> Self {
        self.mounts.push(mount);
        self
    }

    pub fn resources(mut self, resources: ResourceLimits) -> Self {
        self.resources = Some(resources);
        self
    }

    fn upsert_credential(&mut self, credential: CredentialRequest) {
        if let Some(existing) = self
            .credentials
            .iter_mut()
            .find(|existing| existing.profile == credential.profile)
        {
            *existing = credential;
        } else {
            self.credentials.push(credential);
        }
    }
}
