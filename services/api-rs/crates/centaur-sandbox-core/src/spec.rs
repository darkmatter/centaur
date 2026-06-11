use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SandboxSpec {
    pub image: String,
    #[serde(default)]
    pub labels: std::collections::BTreeMap<String, String>,
    pub command: Option<Vec<String>>,
    pub args: Vec<String>,
    pub env: Vec<EnvVar>,
    pub working_dir: Option<String>,
    pub mounts: Vec<Mount>,
    pub resources: Option<ResourceLimits>,
    /// iron-control principal OID (``prn_…``) this sandbox's egress proxy
    /// should act as. When set, the backend registers/binds an iron-control
    /// proxy for the sandbox instead of rendering a static proxy config.
    #[serde(default)]
    pub iron_control_principal: Option<String>,
    /// Operator-facing runtime identity stamped by the control plane. This is
    /// not used by backends for scheduling; it lets API responses, logs, and
    /// pod annotations identify what ran.
    #[serde(default)]
    pub runtime_identity: SandboxRuntimeIdentity,
}

impl SandboxSpec {
    pub fn new(image: impl Into<String>) -> Self {
        let image = image.into();
        Self {
            runtime_identity: SandboxRuntimeIdentity::from_base_image(&image),
            image,
            labels: std::collections::BTreeMap::new(),
            command: None,
            args: Vec::new(),
            env: Vec::new(),
            working_dir: None,
            mounts: Vec::new(),
            resources: None,
            iron_control_principal: None,
        }
    }

    pub fn iron_control_principal(mut self, principal_foreign_id: impl Into<String>) -> Self {
        self.iron_control_principal = Some(principal_foreign_id.into());
        self
    }

    pub fn label(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.labels.insert(name.into(), value.into());
        self
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

    pub fn runtime_identity(mut self, identity: SandboxRuntimeIdentity) -> Self {
        self.runtime_identity = identity;
        self
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct SandboxRuntimeIdentity {
    #[serde(default)]
    pub base_image_ref: Option<String>,
    #[serde(default)]
    pub base_image_hash: Option<String>,
    #[serde(default)]
    pub overlay_hash: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

impl SandboxRuntimeIdentity {
    pub fn from_base_image(image_ref: &str) -> Self {
        Self {
            base_image_ref: non_empty(image_ref),
            base_image_hash: image_ref_hash(image_ref),
            overlay_hash: None,
            model: None,
        }
    }

    pub fn overlay_hash(mut self, value: Option<String>) -> Self {
        self.overlay_hash = value.and_then(|value| non_empty(&value));
        self
    }

    pub fn model(mut self, value: Option<String>) -> Self {
        self.model = value.and_then(|value| non_empty(&value));
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EnvVar {
    pub name: String,
    pub value: String,
}

impl EnvVar {
    pub fn new(name: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            value: value.into(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Mount {
    pub kind: MountKind,
    pub target_path: String,
    pub read_only: bool,
}

impl Mount {
    pub fn new(kind: MountKind, target_path: impl Into<String>) -> Self {
        Self {
            kind,
            target_path: target_path.into(),
            read_only: false,
        }
    }

    pub fn read_only(mut self) -> Self {
        self.read_only = true;
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum MountKind {
    EmptyDir,
    NamedVolume(String),
    Bind { source_path: String },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResourceLimits {
    pub cpu_millis: Option<u32>,
    pub memory_bytes: Option<u64>,
}

impl ResourceLimits {
    pub fn new() -> Self {
        Self {
            cpu_millis: None,
            memory_bytes: None,
        }
    }

    pub fn cpu_millis(mut self, cpu_millis: u32) -> Self {
        self.cpu_millis = Some(cpu_millis);
        self
    }

    pub fn memory_bytes(mut self, memory_bytes: u64) -> Self {
        self.memory_bytes = Some(memory_bytes);
        self
    }
}

impl Default for ResourceLimits {
    fn default() -> Self {
        Self::new()
    }
}

pub fn image_ref_hash(image_ref: &str) -> Option<String> {
    let image_ref = image_ref.trim();
    if image_ref.is_empty() {
        return None;
    }
    if let Some((_, digest)) = image_ref.rsplit_once('@') {
        return non_empty(digest);
    }
    let tail = image_ref.rsplit('/').next().unwrap_or(image_ref);
    let (_, tag) = tail.rsplit_once(':')?;
    let tag = tag.trim();
    if is_sha_like_tag(tag) || tag.to_ascii_lowercase().contains("sha-") {
        return Some(tag.to_owned());
    }
    None
}

fn is_sha_like_tag(value: &str) -> bool {
    let value = value
        .strip_prefix("sha-")
        .or_else(|| value.strip_prefix("sha_"))
        .unwrap_or(value);
    (7..=64).contains(&value.len()) && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{SandboxSpec, image_ref_hash};

    #[test]
    fn extracts_image_hash_from_digest_or_sha_tag() {
        assert_eq!(
            image_ref_hash("ghcr.io/org/agent@sha256:abc123"),
            Some("sha256:abc123".to_owned())
        );
        assert_eq!(
            image_ref_hash("ghcr.io/org/agent:sha-deadbeef"),
            Some("sha-deadbeef".to_owned())
        );
        assert_eq!(image_ref_hash("ghcr.io/org/agent:latest"), None);
    }

    #[test]
    fn sandbox_spec_defaults_base_runtime_identity_from_image() {
        let spec = SandboxSpec::new("ghcr.io/org/agent:sha-deadbeef");

        assert_eq!(
            spec.runtime_identity.base_image_ref.as_deref(),
            Some("ghcr.io/org/agent:sha-deadbeef")
        );
        assert_eq!(
            spec.runtime_identity.base_image_hash.as_deref(),
            Some("sha-deadbeef")
        );
    }
}
