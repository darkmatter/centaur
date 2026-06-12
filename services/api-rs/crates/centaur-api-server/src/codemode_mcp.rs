use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};

use axum::Router;
use centaur_iron_control::SessionRegistrar;
use centaur_sandbox_core::{SandboxId, SandboxIoGuard, SandboxRead, SandboxWrite};
use centaur_session_core::{
    AgentBoxAccessRole, AgentBoxOwnerKey, AgentBoxOwnerScope, AgentBoxPrincipalId, AgentProfileId,
};
use centaur_session_runtime::{AgentBoxRuntime, EnsureAgentBoxRequest, SandboxRuntime};
use rmcp::{
    ErrorData, RoleServer, ServerHandler,
    handler::server::wrapper::Parameters,
    model::{CallToolResult, Content, ServerCapabilities, ServerInfo},
    schemars,
    service::RequestContext,
    tool, tool_handler, tool_router,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{Mutex, oneshot},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct CodeModeMcpConfig {
    pub runtime: SandboxRuntime,
    pub agent_box_runtime: AgentBoxRuntime,
    pub index_path: PathBuf,
    pub iron_control: Option<SessionRegistrar>,
    pub max_output_bytes: usize,
    pub default_timeout_seconds: u64,
    pub default_principal: String,
    pub box_profile_id: AgentProfileId,
    pub box_profile_display_name: String,
    pub box_profile_distribution_ref: Option<String>,
}

pub fn nest_codemode_mcp<S>(router: Router<S>, config: CodeModeMcpConfig) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    let cancellation = CancellationToken::new();
    let http_config = StreamableHttpServerConfig::default()
        .with_cancellation_token(cancellation.child_token())
        .disable_allowed_hosts();
    let executor = Arc::new(CodeModeExecutor::new(config));
    let service_executor = Arc::clone(&executor);
    let service = StreamableHttpService::new(
        move || {
            Ok(CodeModeServer {
                executor: Arc::clone(&service_executor),
            })
        },
        Arc::new(LocalSessionManager::default()),
        http_config,
    );
    router.nest_service("/mcp", service)
}

#[derive(Clone)]
struct CodeModeServer {
    executor: Arc<CodeModeExecutor>,
}

#[tool_router]
impl CodeModeServer {
    #[tool(
        description = "List or search Centaur tools. Without `query`: full catalog, one `name<TAB>description` per line. With `query`: server-side case-insensitive search over names, descriptions, and method signatures/docstrings, with matching methods shown inline. Prefer searching over listing everything. Call tool_api next for a tool's full method signatures."
    )]
    async fn list_tools(
        &self,
        Parameters(ListToolsParams { query }): Parameters<ListToolsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let index = ToolIndex::load(&self.executor.config.index_path).await?;
        let needle = query
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .to_lowercase();
        let mut entries: Vec<String> = if needle.is_empty() {
            index
                .projects
                .iter()
                .map(|project| format!("{}\t{}", project.name, project.description))
                .collect()
        } else {
            index
                .projects
                .iter()
                .filter_map(|project| project.search_entry(&needle))
                .collect()
        };
        entries.sort();
        if entries.is_empty() {
            return Ok(CallToolResult::success(vec![Content::text(format!(
                "no tools matched {:?}; retry with a broader query or omit it for the full catalog",
                needle
            ))]));
        }
        Ok(CallToolResult::success(vec![Content::text(
            entries.join("\n"),
        )]))
    }

    #[tool(
        description = "Show the Python method signatures for one Centaur tool. Signatures match the `centaur_tools` library used inside run_python scripts exactly."
    )]
    async fn tool_api(
        &self,
        Parameters(ToolApiParams { tool }): Parameters<ToolApiParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let index = ToolIndex::load(&self.executor.config.index_path).await?;
        match index.project(&tool) {
            Some(project) => Ok(CallToolResult::success(vec![Content::text(project.stub())])),
            None => {
                let mut known: Vec<&str> = index
                    .projects
                    .iter()
                    .map(|project| project.name.as_str())
                    .collect();
                known.sort_unstable();
                Ok(CallToolResult::error(vec![Content::text(format!(
                    "unknown tool: {tool}\nknown tools: {}",
                    known.join(", ")
                ))]))
            }
        }
    }

    #[tool(
        description = "Execute a Python script that composes Centaur tools; returns its printed output. Tools are a Python library: `from centaur_tools import slack, linear` then call methods from tool_api (results are dicts/lists). Compose as many calls as needed in ONE script — loops, joins, ThreadPoolExecutor(max_workers=8) fan-out — and print only the distilled result; output is capped. Hyphenated tools: centaur_tools.tool(\"name\")."
    )]
    async fn run_python(
        &self,
        Parameters(RunPythonParams {
            script,
            timeout_seconds,
        }): Parameters<RunPythonParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let principal = self
            .executor
            .resolve_principal(self.executor.principal_from_context(&context))
            .await?;
        let output = self
            .executor
            .run_python(&principal, script, timeout_seconds)
            .await?;
        let content = vec![Content::text(output.output)];
        Ok(if output.is_error {
            CallToolResult::error(content)
        } else {
            CallToolResult::success(content)
        })
    }
}

#[tool_handler]
impl ServerHandler for CodeModeServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(
            "Centaur Code Mode: compose Centaur deployment tools in Python. \
             Workflow: list_tools(query=<keywords>) to find relevant tools → \
             tool_api(<tool>) for full signatures → run_python(<script>). \
             Write ONE script per task that makes all the tool calls it needs \
             and prints only the distilled result.",
        )
    }
}

struct CodeModeExecutor {
    config: CodeModeMcpConfig,
    sessions: Mutex<HashMap<String, Arc<SandboxSession>>>,
    claim_lock: Mutex<()>,
}

type PendingResponse = oneshot::Sender<Result<PythonRunOutput, String>>;
type PendingResponses = Arc<Mutex<HashMap<String, PendingResponse>>>;

struct SandboxSession {
    sandbox_id: SandboxId,
    stdin: Mutex<SandboxWrite>,
    pending: PendingResponses,
}

#[derive(Debug)]
struct PrincipalRequest {
    key: String,
    name: Option<String>,
    thread_key: Option<String>,
    slack_user_id: Option<String>,
}

#[derive(Debug)]
struct ResolvedPrincipal {
    session_key: String,
    env_principal: String,
    iron_control_principal: Option<String>,
}

#[derive(Debug)]
struct PythonRunOutput {
    output: String,
    is_error: bool,
}

impl CodeModeExecutor {
    fn new(config: CodeModeMcpConfig) -> Self {
        Self {
            config,
            sessions: Mutex::new(HashMap::new()),
            claim_lock: Mutex::new(()),
        }
    }

    fn principal_from_context(&self, context: &RequestContext<RoleServer>) -> PrincipalRequest {
        let parts = context.extensions.get::<http::request::Parts>();
        let thread_key = header_value(parts, "x-centaur-thread-key");
        let slack_user_id = header_value(parts, "x-centaur-slack-user-id")
            .or_else(|| header_value(parts, "x-slack-user-id"));
        let principal = header_value(parts, "x-centaur-principal")
            .or_else(|| thread_key.clone())
            .unwrap_or_else(|| self.config.default_principal.clone());
        PrincipalRequest {
            key: principal,
            name: header_value(parts, "x-centaur-principal-name"),
            thread_key,
            slack_user_id,
        }
    }

    async fn resolve_principal(
        &self,
        request: PrincipalRequest,
    ) -> Result<ResolvedPrincipal, ErrorData> {
        let Some(registrar) = &self.config.iron_control else {
            return Ok(ResolvedPrincipal {
                session_key: request.key.clone(),
                env_principal: request.key,
                iron_control_principal: None,
            });
        };

        if request.key.starts_with("prn_") {
            return Ok(ResolvedPrincipal {
                session_key: request.key.clone(),
                env_principal: request.key.clone(),
                iron_control_principal: Some(request.key),
            });
        }

        let principal = if let Some(thread_key) = request.thread_key.as_deref() {
            registrar
                .register_session(thread_key, request.slack_user_id.as_deref())
                .await
        } else {
            registrar
                .register_foreign_principal(&request.key, request.name.as_deref())
                .await
        }
        .map_err(|err| {
            ErrorData::internal_error(format!("registering Code Mode principal: {err}"), None)
        })?;

        Ok(ResolvedPrincipal {
            session_key: principal.id.clone(),
            env_principal: principal.foreign_id.unwrap_or(principal.id.clone()),
            iron_control_principal: Some(principal.id),
        })
    }

    async fn run_python(
        &self,
        principal: &ResolvedPrincipal,
        script: String,
        timeout_seconds: Option<u64>,
    ) -> Result<PythonRunOutput, ErrorData> {
        match self
            .run_python_once(principal, script.clone(), timeout_seconds)
            .await
        {
            Ok(output) => Ok(output),
            Err(first) => {
                tracing::warn!(
                    principal = %principal.env_principal,
                    session_key = %principal.session_key,
                    error = %first,
                    "Code Mode sandbox exec failed; reclaiming once"
                );
                self.drop_session(principal).await;
                self.run_python_once(principal, script, timeout_seconds)
                    .await
            }
        }
    }

    async fn run_python_once(
        &self,
        principal: &ResolvedPrincipal,
        script: String,
        timeout_seconds: Option<u64>,
    ) -> Result<PythonRunOutput, ErrorData> {
        let session = self.session(principal).await?;
        let request = RunPythonRequest {
            id: format!("run_{}", uuid::Uuid::new_v4()),
            request_type: "codemode.run_python",
            script,
            timeout_seconds,
            max_output_bytes: Some(self.config.max_output_bytes),
            principal: Some(principal.env_principal.clone()),
        };
        let request_id = request.id.clone();
        let (tx, rx) = oneshot::channel();
        session.pending.lock().await.insert(request_id.clone(), tx);

        let line = serde_json::to_string(&request).map_err(internal_error)?;
        let write_result = async {
            let mut stdin = session.stdin.lock().await;
            stdin.write_all(line.as_bytes()).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await
        }
        .await;
        if let Err(error) = write_result {
            session.pending.lock().await.remove(&request_id);
            return Err(internal_error(error));
        }

        let wait_timeout = Duration::from_secs(
            timeout_seconds
                .unwrap_or(self.config.default_timeout_seconds)
                .saturating_add(30),
        );
        let response = tokio::time::timeout(wait_timeout, rx)
            .await
            .map_err(|_| ErrorData::internal_error("Code Mode sandbox response timed out", None))?
            .map_err(|_| {
                ErrorData::internal_error("Code Mode sandbox response channel closed", None)
            })?
            .map_err(|message| ErrorData::internal_error(message, None))?;
        Ok(response)
    }

    async fn session(
        &self,
        principal: &ResolvedPrincipal,
    ) -> Result<Arc<SandboxSession>, ErrorData> {
        if let Some(session) = self
            .sessions
            .lock()
            .await
            .get(&principal.session_key)
            .cloned()
        {
            return Ok(session);
        }
        let _claim_guard = self.claim_lock.lock().await;
        if let Some(session) = self
            .sessions
            .lock()
            .await
            .get(&principal.session_key)
            .cloned()
        {
            return Ok(session);
        }

        let request = self.agent_box_request(principal)?;
        let (agent_box, io) = self
            .config
            .agent_box_runtime
            .ensure_running_box_io(request)
            .await
            .map_err(|error| {
                ErrorData::internal_error(format!("creating Code Mode agent box: {error}"), None)
            })?;
        let sandbox_id = SandboxId::new(
            agent_box
                .active_sandbox_id
                .as_deref()
                .ok_or_else(|| {
                    ErrorData::internal_error(
                        format!(
                            "Code Mode agent box {} has no active sandbox",
                            agent_box.box_id
                        ),
                        None,
                    )
                })?
                .to_owned(),
        );

        let pending = Arc::new(Mutex::new(HashMap::new()));
        let session = Arc::new(SandboxSession {
            sandbox_id: sandbox_id.clone(),
            stdin: Mutex::new(io.stdin),
            pending: Arc::clone(&pending),
        });
        tokio::spawn(read_responses(
            sandbox_id.clone(),
            io.stdout,
            Arc::clone(&pending),
            io.guard,
        ));
        tokio::spawn(pump_stderr(sandbox_id.clone(), io.stderr));

        self.sessions
            .lock()
            .await
            .insert(principal.session_key.clone(), Arc::clone(&session));
        tracing::info!(
            principal = %principal.env_principal,
            session_key = %principal.session_key,
            sandbox_id = %sandbox_id.as_str(),
            agent_box_id = %agent_box.box_id,
            profile_id = %agent_box.profile_id,
            "claimed Code Mode sandbox"
        );
        Ok(session)
    }

    fn agent_box_request(
        &self,
        principal: &ResolvedPrincipal,
    ) -> Result<EnsureAgentBoxRequest, ErrorData> {
        Ok(EnsureAgentBoxRequest {
            profile_id: self.config.box_profile_id.clone(),
            profile_display_name: self.config.box_profile_display_name.clone(),
            profile_distribution_ref: self.config.box_profile_distribution_ref.clone(),
            owner_scope: owner_scope_for_principal(&principal.env_principal),
            owner_key: AgentBoxOwnerKey::parse(principal.env_principal.clone())
                .map_err(internal_error)?,
            egress_principal_id: principal.iron_control_principal.clone(),
            grant_principal_id: Some(
                AgentBoxPrincipalId::parse(principal.session_key.clone())
                    .map_err(internal_error)?,
            ),
            grant_role: AgentBoxAccessRole::Owner,
            metadata: json!({
                "source": "codemode_mcp",
                "env_principal": principal.env_principal,
            }),
        })
    }

    async fn drop_session(&self, principal: &ResolvedPrincipal) {
        let session = self.sessions.lock().await.remove(&principal.session_key);
        if let Some(session) = session {
            let _ = self.config.runtime.stop_sandbox(&session.sandbox_id).await;
        }
    }
}

fn header_value(parts: Option<&http::request::Parts>, name: &'static str) -> Option<String> {
    parts
        .and_then(|parts| parts.headers.get(name))
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn owner_scope_for_principal(principal: &str) -> AgentBoxOwnerScope {
    if principal.starts_with("slack-user-") {
        AgentBoxOwnerScope::User
    } else if principal.starts_with("slack-channel-") {
        AgentBoxOwnerScope::Channel
    } else if principal.starts_with("slack-team-") {
        AgentBoxOwnerScope::Team
    } else {
        AgentBoxOwnerScope::Custom
    }
}

async fn read_responses(
    sandbox_id: SandboxId,
    stdout: SandboxRead,
    pending: PendingResponses,
    _guard: SandboxIoGuard,
) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => match serde_json::from_str::<MultiplexerEvent>(&line) {
                Ok(response) => {
                    handle_multiplexer_event(&sandbox_id, response, &pending).await;
                }
                Err(error) => tracing::warn!(
                    sandbox_id = %sandbox_id.as_str(),
                    %error,
                    line,
                    "invalid Code Mode response"
                ),
            },
            Ok(None) => break,
            Err(error) => {
                tracing::warn!(
                    sandbox_id = %sandbox_id.as_str(),
                    %error,
                    "Code Mode stdout reader failed"
                );
                break;
            }
        }
    }
    let mut pending = pending.lock().await;
    for (_, sender) in pending.drain() {
        let _ = sender.send(Err(format!(
            "Code Mode sandbox {} closed stdout",
            sandbox_id.as_str()
        )));
    }
}

async fn pump_stderr(sandbox_id: SandboxId, stderr: SandboxRead) {
    let mut lines = BufReader::new(stderr).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => tracing::debug!(
                sandbox_id = %sandbox_id.as_str(),
                stderr = %line,
                "Code Mode sandbox stderr"
            ),
            Ok(None) => break,
            Err(error) => {
                tracing::warn!(
                    sandbox_id = %sandbox_id.as_str(),
                    %error,
                    "Code Mode sandbox stderr pump failed"
                );
                break;
            }
        }
    }
}

fn internal_error(error: impl std::fmt::Display) -> ErrorData {
    ErrorData::internal_error(error.to_string(), None)
}

async fn handle_multiplexer_event(
    sandbox_id: &SandboxId,
    response: MultiplexerEvent,
    pending: &PendingResponses,
) {
    let response_id = response.id.clone();
    let result = match response.event {
        MultiplexerEventKind::CodeModeResult { output, is_error } => {
            Some(Ok(PythonRunOutput { output, is_error }))
        }
        MultiplexerEventKind::Error { message } => Some(Err(message)),
        MultiplexerEventKind::Unknown => {
            tracing::debug!(
                sandbox_id = %sandbox_id.as_str(),
                response_id,
                "ignoring non-CodeMode multiplexer event"
            );
            None
        }
    };
    let Some(result) = result else {
        return;
    };
    if let Some(sender) = pending.lock().await.remove(&response_id) {
        let _ = sender.send(result);
    } else {
        tracing::warn!(
            sandbox_id = %sandbox_id.as_str(),
            response_id,
            "received stale Code Mode response"
        );
    }
}

#[derive(Debug, Serialize)]
struct RunPythonRequest {
    id: String,
    #[serde(rename = "type")]
    request_type: &'static str,
    script: String,
    timeout_seconds: Option<u64>,
    max_output_bytes: Option<usize>,
    principal: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MultiplexerEvent {
    id: String,
    #[serde(flatten)]
    event: MultiplexerEventKind,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum MultiplexerEventKind {
    #[serde(rename = "codemode.result")]
    CodeModeResult { output: String, is_error: bool },
    #[serde(rename = "error")]
    Error { message: String },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ListToolsParams {
    query: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ToolApiParams {
    tool: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct RunPythonParams {
    script: String,
    timeout_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ToolIndex {
    #[serde(default)]
    projects: Vec<ToolProject>,
}

#[derive(Debug, Deserialize)]
struct ToolProject {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    api: Vec<ApiEntry>,
}

#[derive(Debug, Deserialize)]
struct ApiEntry {
    signature: String,
    #[serde(default)]
    doc: Option<String>,
}

impl ToolIndex {
    async fn load(path: &std::path::Path) -> Result<Self, ErrorData> {
        let raw = tokio::fs::read(path).await.map_err(|err| {
            ErrorData::internal_error(
                format!(
                    "tool index {} unreadable ({err}); run install-tool-shims first",
                    path.display()
                ),
                None,
            )
        })?;
        serde_json::from_slice(&raw).map_err(|err| {
            ErrorData::internal_error(format!("tool index parse failed: {err}"), None)
        })
    }

    fn project(&self, name: &str) -> Option<&ToolProject> {
        let dashed = name.replace('_', "-");
        self.projects
            .iter()
            .find(|project| project.name == name || project.name == dashed)
    }
}

const SEARCH_METHODS_PER_TOOL: usize = 6;

impl ToolProject {
    fn search_entry(&self, needle: &str) -> Option<String> {
        let header_match = self.name.to_lowercase().contains(needle)
            || self.description.to_lowercase().contains(needle);
        let matched: Vec<&ApiEntry> = self
            .api
            .iter()
            .filter(|entry| {
                entry.signature.to_lowercase().contains(needle)
                    || entry
                        .doc
                        .as_deref()
                        .is_some_and(|doc| doc.to_lowercase().contains(needle))
            })
            .collect();
        if !header_match && matched.is_empty() {
            return None;
        }
        let mut lines = vec![format!("{}\t{}", self.name, self.description)];
        for entry in matched.iter().take(SEARCH_METHODS_PER_TOOL) {
            match &entry.doc {
                Some(doc) => lines.push(format!("  {}  # {}", entry.signature, doc)),
                None => lines.push(format!("  {}", entry.signature)),
            }
        }
        if matched.len() > SEARCH_METHODS_PER_TOOL {
            lines.push(format!(
                "  ... {} more matching methods (see tool_api)",
                matched.len() - SEARCH_METHODS_PER_TOOL
            ));
        }
        Some(lines.join("\n"))
    }

    fn stub(&self) -> String {
        let mut lines = Vec::new();
        let header = format!("# {}: {}", self.name, self.description);
        lines.push(header.trim_end().trim_end_matches(':').to_owned());
        let import_name = self.name.replace('-', "_");
        if self.name.contains('-') {
            lines.push(format!("# python: centaur_tools.tool(\"{}\")", self.name));
        } else {
            lines.push(format!("# python: from centaur_tools import {import_name}"));
        }
        if self.api.is_empty() {
            lines.push("# no client API extracted for this tool".to_owned());
        }
        for entry in &self.api {
            lines.push(entry.signature.clone());
            if let Some(doc) = &entry.doc {
                lines.push(format!("    # {doc}"));
            }
        }
        lines.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn principal_prefixes_map_to_box_owner_scopes() {
        assert_eq!(
            owner_scope_for_principal("slack-user-T123-U123"),
            AgentBoxOwnerScope::User
        );
        assert_eq!(
            owner_scope_for_principal("slack-channel-T123-C123"),
            AgentBoxOwnerScope::Channel
        );
        assert_eq!(
            owner_scope_for_principal("slack-team-T123"),
            AgentBoxOwnerScope::Team
        );
        assert_eq!(
            owner_scope_for_principal("prn_123"),
            AgentBoxOwnerScope::Custom
        );
    }
}
