//! Centaur Code Mode MCP server.
//!
//! Exposes Centaur's deployment tools to *external* MCP clients (local Claude
//! Code, Codex, etc. — typically over Tailscale) as three MCP tools instead of
//! one schema per Centaur tool:
//!
//! - `list_tools` → tool catalog (name + description)
//! - `tool_api`   → compact Python method signatures for one tool
//! - `run_python` → execute a Python script that composes tools via the
//!   `centaur_tools` proxy, returning only what the script prints
//!
//! This collapses N network roundtrips (one per tool call) into one per
//! script and keeps the client's context to 3 schemas instead of ~74. Scripts
//! run as killable subprocesses of the union-env Python built by
//! `install-tool-shims --env`; tool calls inside a script are in-process.
//!
//! Internal sandboxes do NOT consume this service — they mount the tools
//! directly (CLI shims + in-process `centaur_tools` proxy).
//!
//! Security: `run_python` executes arbitrary Python next to the tool tree.
//! Bind to loopback (default) or the tailnet only; tool secrets are not
//! readable by scripts — they are injected at the egress proxy.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use clap::Parser;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content, ServerCapabilities, ServerInfo};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, ServerHandler, schemars, tool, tool_handler, tool_router};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

#[derive(Parser, Debug)]
#[command(
    name = "centaur-codemode-mcp",
    about = "Code Mode MCP server for external Centaur tool access"
)]
struct Args {
    /// Address to bind. Keep on loopback or a tailnet interface; this service
    /// executes model-written Python.
    #[arg(long, env = "CODEMODE_BIND", default_value = "127.0.0.1:8765")]
    bind: SocketAddr,

    /// Directory holding the `centaur-tools` catalog and `.centaur-tools.json`
    /// index written by install-tool-shims.
    #[arg(long, env = "CENTAUR_TOOL_BIN_DIR", default_value_os_t = default_home_path(".local/bin"))]
    bin_dir: PathBuf,

    /// Directory holding the generated `centaur_tools` Python proxy package.
    #[arg(
        long,
        env = "CENTAUR_TOOL_PROXY_DIR",
        default_value_os_t = default_home_path(".local/share/centaur-tools/python")
    )]
    proxy_dir: PathBuf,

    /// Union venv built by `install-tool-shims --env`.
    #[arg(
        long,
        env = "CENTAUR_TOOL_ENV_DIR",
        default_value_os_t = default_home_path(".local/share/centaur-tools/venv")
    )]
    env_dir: PathBuf,

    /// Cap on returned script stdout (bytes). The default keeps a careless
    /// script (raw API dump) to ~2.5k tokens of client context; distilled
    /// output should be far below it.
    #[arg(long, env = "CODEMODE_MAX_OUTPUT_BYTES", default_value_t = 10_000)]
    max_output_bytes: usize,

    /// Default `run_python` timeout (seconds).
    #[arg(long, env = "CODEMODE_TIMEOUT_SECONDS", default_value_t = 120)]
    default_timeout_seconds: u64,

    /// Host-header allowlist. Empty disables the check; the bind address (and
    /// tailnet membership) is then the access boundary.
    #[arg(
        long = "allowed-host",
        env = "CODEMODE_ALLOWED_HOSTS",
        value_delimiter = ','
    )]
    allowed_hosts: Vec<String>,
}

fn default_home_path(suffix: &str) -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"));
    home.join(suffix)
}

/// Immutable service configuration derived from CLI args.
#[derive(Debug, Clone)]
struct CodeModeConfig {
    index_path: PathBuf,
    proxy_dir: PathBuf,
    python: PathBuf,
    max_output_bytes: usize,
    default_timeout: Duration,
}

impl CodeModeConfig {
    fn from_args(args: &Args) -> Self {
        let venv_python = args.env_dir.join("bin/python");
        let python = if venv_python.is_file() {
            venv_python
        } else {
            PathBuf::from("python3")
        };
        Self {
            index_path: args.bin_dir.join(".centaur-tools.json"),
            proxy_dir: args.proxy_dir.clone(),
            python,
            max_output_bytes: args.max_output_bytes,
            default_timeout: Duration::from_secs(args.default_timeout_seconds),
        }
    }
}

// ── Tool index models (written by install-tool-shims) ───────────────────────

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
                    "tool index {} unreadable ({err}); run install-tool-shims on this host first",
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

/// Max matching method lines rendered per tool in a `list_tools` search.
const SEARCH_METHODS_PER_TOOL: usize = 6;

impl ToolProject {
    /// Render this tool for a search result if it matches `needle`
    /// (lowercase): a `name<TAB>description` header plus matching method
    /// signatures, or `None` when nothing matches.
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
        lines.push(header.trim_end().trim_end_matches(':').to_string());
        let import_name = self.name.replace('-', "_");
        if self.name.contains('-') {
            lines.push(format!("# python: centaur_tools.tool(\"{}\")", self.name));
        } else {
            lines.push(format!("# python: from centaur_tools import {import_name}"));
        }
        if self.api.is_empty() {
            lines.push("# no client API extracted for this tool".to_string());
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

// ── MCP tool parameters ──────────────────────────────────────────────────────

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ListToolsParams {
    /// Optional case-insensitive search. Matches tool names, descriptions, and
    /// method signatures/docstrings; matching methods are shown inline under
    /// each tool. Omit to list the full catalog.
    query: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ToolApiParams {
    /// Tool name as shown by list_tools.
    tool: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct RunPythonParams {
    /// Python script source. Compose Centaur tools via the `centaur_tools`
    /// library and print only the distilled result.
    script: String,
    /// Timeout in seconds (default: server-configured, normally 120).
    timeout_seconds: Option<u64>,
}

// ── Server ───────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct CodeModeServer {
    config: Arc<CodeModeConfig>,
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
        let index = ToolIndex::load(&self.config.index_path).await?;
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
        let index = ToolIndex::load(&self.config.index_path).await?;
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
    ) -> Result<CallToolResult, ErrorData> {
        let timeout = timeout_seconds.map_or(self.config.default_timeout, Duration::from_secs);
        let script_path =
            std::env::temp_dir().join(format!("codemode-{}.py", uuid::Uuid::new_v4()));
        tokio::fs::write(&script_path, &script)
            .await
            .map_err(|err| {
                ErrorData::internal_error(format!("failed to stage script: {err}"), None)
            })?;

        let pythonpath = match std::env::var("PYTHONPATH") {
            Ok(existing) if !existing.is_empty() => {
                format!("{}:{existing}", self.config.proxy_dir.display())
            }
            _ => self.config.proxy_dir.display().to_string(),
        };
        let mut command = tokio::process::Command::new(&self.config.python);
        command
            .arg(&script_path)
            .env("PYTHONPATH", pythonpath)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);

        let result = tokio::time::timeout(timeout, command.output()).await;
        let _ = tokio::fs::remove_file(&script_path).await;

        let output = match result {
            Err(_) => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "error: script timed out after {}s",
                    timeout.as_secs()
                ))]));
            }
            Ok(spawned) => spawned.map_err(|err| {
                ErrorData::internal_error(
                    format!("failed to run {}: {err}", self.config.python.display()),
                    None,
                )
            })?,
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut parts = Vec::new();
        if !stdout.trim().is_empty() {
            parts.push(truncate(stdout.trim_end(), self.config.max_output_bytes));
        }
        let failed = !output.status.success();
        if failed {
            parts.push(format!("exit code: {}", output.status.code().unwrap_or(-1)));
            let stderr = String::from_utf8_lossy(&output.stderr);
            if !stderr.trim().is_empty() {
                parts.push(truncate(stderr.trim_end(), 4_000));
            }
        }
        if parts.is_empty() {
            parts.push("(no output)".to_string());
        }
        let content = vec![Content::text(parts.join("\n"))];
        Ok(if failed {
            CallToolResult::error(content)
        } else {
            CallToolResult::success(content)
        })
    }
}

fn truncate(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n... [truncated {} bytes]",
        &text[..end],
        text.len() - end
    )
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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().init();

    let args = Args::parse();
    let config = Arc::new(CodeModeConfig::from_args(&args));
    if !config.index_path.is_file() {
        tracing::warn!(
            index = %config.index_path.display(),
            "tool index missing; run install-tool-shims (and --env) on this host"
        );
    }
    tracing::info!(
        bind = %args.bind,
        python = %config.python.display(),
        index = %config.index_path.display(),
        "starting Code Mode MCP server"
    );

    let cancellation = CancellationToken::new();
    let mut http_config =
        StreamableHttpServerConfig::default().with_cancellation_token(cancellation.child_token());
    if args.allowed_hosts.is_empty() {
        http_config = http_config.disable_allowed_hosts();
    } else {
        http_config = http_config.with_allowed_hosts(args.allowed_hosts.clone());
    }

    let service_config = Arc::clone(&config);
    let service = StreamableHttpService::new(
        move || {
            Ok(CodeModeServer {
                config: Arc::clone(&service_config),
            })
        },
        Arc::new(LocalSessionManager::default()),
        http_config,
    );
    let router = axum::Router::new().nest_service("/mcp", service);

    let listener = tokio::net::TcpListener::bind(args.bind)
        .await
        .context("binding listener")?;
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            cancellation.cancel();
        })
        .await
        .context("serving MCP")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str, api: Vec<ApiEntry>) -> ToolProject {
        ToolProject {
            name: name.to_string(),
            description: "Test tool".to_string(),
            api,
        }
    }

    #[test]
    fn stub_renders_import_line_and_signatures() {
        let stub = project(
            "demo",
            vec![ApiEntry {
                signature: "ping() -> dict".to_string(),
                doc: Some("Return a pong.".to_string()),
            }],
        )
        .stub();
        assert!(stub.contains("from centaur_tools import demo"), "{stub}");
        assert!(stub.contains("ping() -> dict"), "{stub}");
        assert!(stub.contains("# Return a pong."), "{stub}");
    }

    #[test]
    fn stub_uses_tool_escape_hatch_for_hyphenated_names() {
        let stub = project("standard-metrics", vec![]).stub();
        assert!(
            stub.contains("centaur_tools.tool(\"standard-metrics\")"),
            "{stub}"
        );
        assert!(stub.contains("no client API extracted"), "{stub}");
    }

    #[test]
    fn index_lookup_accepts_underscored_alias() {
        let index = ToolIndex {
            projects: vec![project("standard-metrics", vec![])],
        };
        assert!(index.project("standard_metrics").is_some());
        assert!(index.project("standard-metrics").is_some());
        assert!(index.project("missing").is_none());
    }

    #[test]
    fn search_matches_name_description_and_methods() {
        let tool = project(
            "slack",
            vec![
                ApiEntry {
                    signature: "search_messages(query: str) -> list[dict]".to_string(),
                    doc: Some("Search messages.".to_string()),
                },
                ApiEntry {
                    signature: "list_channels() -> list[dict]".to_string(),
                    doc: None,
                },
            ],
        );
        // name match → header only (no methods matched)
        let by_name = tool.search_entry("slack").unwrap();
        assert!(by_name.starts_with("slack\t"), "{by_name}");
        assert!(!by_name.contains("search_messages"), "{by_name}");
        // method match → header + matching signature inline
        let by_method = tool.search_entry("search_mess").unwrap();
        assert!(
            by_method.contains("  search_messages(query: str)"),
            "{by_method}"
        );
        assert!(!by_method.contains("list_channels"), "{by_method}");
        // doc match works, case-insensitively
        assert!(tool.search_entry("search messages.").is_some());
        // no match
        assert!(tool.search_entry("kubernetes").is_none());
    }

    #[test]
    fn search_caps_matching_methods() {
        let api = (0..10)
            .map(|i| ApiEntry {
                signature: format!("query_thing_{i}() -> dict"),
                doc: None,
            })
            .collect();
        let entry = project("dune", api).search_entry("query_thing").unwrap();
        assert_eq!(
            entry.matches("query_thing_").count(),
            SEARCH_METHODS_PER_TOOL
        );
        assert!(entry.contains("... 4 more matching methods"), "{entry}");
    }

    #[test]
    fn truncate_respects_char_boundaries() {
        let text = "héllo wörld".repeat(100);
        let out = truncate(&text, 13);
        assert!(out.contains("[truncated"));
        let plain = truncate("short", 100);
        assert_eq!(plain, "short");
    }
}
