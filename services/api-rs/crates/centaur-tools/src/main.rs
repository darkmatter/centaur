use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use clap::{CommandFactory, Parser, Subcommand};
use regex::Regex;
use serde_json::json;
use thiserror::Error;

const PYTHON_BRIDGE: &str = r#"
import importlib.util
import pathlib
import re
import sys
import types

tool_dir = pathlib.Path(sys.argv[1]).resolve()
tool_name = sys.argv[2]
args = sys.argv[3:]
package_name = "centaur_cli_" + re.sub(r"[^A-Za-z0-9_]", "_", tool_name)

for parent in (tool_dir, *tool_dir.parents):
    if (parent / "centaur_sdk").is_dir():
        sys.path.insert(0, str(parent))
        break

package = types.ModuleType(package_name)
package.__path__ = [str(tool_dir)]
sys.modules[package_name] = package

spec = importlib.util.spec_from_file_location(f"{package_name}.cli", tool_dir / "cli.py")
if spec is None or spec.loader is None:
    raise SystemExit(f"could not load CLI for {tool_name}")
module = importlib.util.module_from_spec(spec)
module.__package__ = package_name
sys.modules[spec.name] = module
spec.loader.exec_module(module)

app = getattr(module, "app", None)
if app is None:
    raise SystemExit(f"{tool_name} has no Typer app named 'app'")
sys.argv = [tool_name, *args]
app()
"#;

#[derive(Debug, Parser)]
#[command(
    name = "centaur-tools",
    about = "List and run local Centaur CLI tools",
    disable_help_subcommand = true
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// List available local CLI tools.
    List,
    /// Show commands and run syntax for one tool.
    Discover { tool: String },
    /// Run a local CLI tool.
    Run {
        tool: String,
        #[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<OsString>,
    },
    /// Print command help.
    Help,
}

#[derive(Debug, Error)]
enum Error {
    #[error("failed to read {path}: {source}")]
    ReadFile {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to create {path}: {source}")]
    CreateDir {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to spawn {program}: {source}")]
    Spawn {
        program: String,
        source: std::io::Error,
    },
    #[error("failed to print help: {0}")]
    PrintHelp(std::io::Error),
    #[error("failed to write Python bridge to uv: {0}")]
    WriteBridge(std::io::Error),
    #[error("HOME is not set and XDG_CACHE_HOME was not provided")]
    MissingHome,
    #[error("failed to open stdin for Python bridge")]
    MissingBridgeStdin,
}

type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, Eq, PartialEq)]
struct ToolRow {
    name: String,
    dir: PathBuf,
    summary: String,
    command_count: usize,
    kind: RunnerKind,
    runner: PathBuf,
    commands: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RunnerKind {
    Exec,
    Node,
    Python,
    Shell,
}

impl RunnerKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Exec => "exec",
            Self::Node => "node",
            Self::Python => "python",
            Self::Shell => "shell",
        }
    }
}

fn main() {
    let cli = Cli::parse();
    match run(cli) {
        Ok(code) => std::process::exit(code),
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    }
}

fn run(cli: Cli) -> Result<i32> {
    match cli.command.unwrap_or(Commands::List) {
        Commands::List => {
            print!("{}", list_tools());
            Ok(0)
        }
        Commands::Discover { tool } => discover_tool(&tool),
        Commands::Run { tool, args } => run_tool(&tool, args),
        Commands::Help => {
            Cli::command().print_help().map_err(Error::PrintHelp)?;
            println!();
            Ok(0)
        }
    }
}

fn list_tools() -> String {
    let rows = discover_rows();
    let mut out = format!("[{}]{{tool,type,commands,summary}}:\n", rows.len());
    for row in rows {
        out.push_str(&format!(
            "  {},{},{},{}\n",
            row.name,
            row.kind.as_str(),
            row.command_count,
            row.summary
        ));
    }
    out
}

fn discover_tool(tool: &str) -> Result<i32> {
    let Some(row) = find_tool_row(tool) else {
        println!("{}", json!({"error": "unknown_tool", "tool": tool}));
        return Ok(1);
    };

    println!("tool: {}", row.name);
    println!("type: {}", row.kind.as_str());
    println!("summary: {}", row.summary);
    println!("dir: {}", row.dir.display());
    println!("runner: {}", row.runner.display());
    if row.kind == RunnerKind::Python {
        println!("run: centaur-tools run {} <command> [args...]", row.name);
    } else {
        println!("run: centaur-tools run {} [args...]", row.name);
    }
    println!("[{}]{{command}}:", row.command_count);
    for command in row.commands {
        println!("  {command}");
    }
    if row.command_count == 0 {
        println!();
    }
    Ok(0)
}

fn run_tool(tool: &str, args: Vec<OsString>) -> Result<i32> {
    let Some(row) = find_tool_row(tool) else {
        println!("{}", json!({"error": "unknown_tool", "tool": tool}));
        return Ok(1);
    };

    match row.kind {
        RunnerKind::Shell => run_external("sh", [row.runner.as_os_str()], &args, &row.dir),
        RunnerKind::Node => run_external("node", [row.runner.as_os_str()], &args, &row.dir),
        RunnerKind::Exec => {
            if !is_executable(&row.runner) {
                println!(
                    "{}",
                    json!({
                        "error": "runner_not_executable",
                        "tool": row.name,
                        "runner": row.runner,
                    })
                );
                return Ok(1);
            }
            run_external(&row.runner, std::iter::empty::<&OsStr>(), &args, &row.dir)
        }
        RunnerKind::Python => run_python_tool(&row, &args),
    }
}

fn run_external<P, I, A>(program: P, prefix_args: I, args: &[OsString], dir: &Path) -> Result<i32>
where
    P: AsRef<OsStr>,
    I: IntoIterator<Item = A>,
    A: AsRef<OsStr>,
{
    let program_ref = program.as_ref();
    let status = Command::new(program_ref)
        .args(prefix_args)
        .args(args)
        .current_dir(dir)
        .status()
        .map_err(|source| Error::Spawn {
            program: program_ref.to_string_lossy().into_owned(),
            source,
        })?;
    Ok(exit_code(status))
}

fn run_python_tool(row: &ToolRow, args: &[OsString]) -> Result<i32> {
    let env_dir = python_env_dir(&row.name, &row.dir)?;
    if let Some(parent) = env_dir.parent() {
        fs::create_dir_all(parent).map_err(|source| Error::CreateDir {
            path: parent.to_path_buf(),
            source,
        })?;
    }

    let python = env_dir.join("bin").join("python");
    let venv_status = Command::new("uv")
        .args(["venv", "--quiet", "--allow-existing"])
        .arg(&env_dir)
        .current_dir(&row.dir)
        .status()
        .map_err(|source| Error::Spawn {
            program: "uv venv".to_owned(),
            source,
        })?;
    if !venv_status.success() {
        return Ok(exit_code(venv_status));
    }

    let pip_status = Command::new("uv")
        .args(["pip", "install", "--python"])
        .arg(&python)
        .args(["--quiet", "-r", "pyproject.toml"])
        .current_dir(&row.dir)
        .status()
        .map_err(|source| Error::Spawn {
            program: "uv pip install".to_owned(),
            source,
        })?;
    if !pip_status.success() {
        return Ok(exit_code(pip_status));
    }

    let mut child = Command::new("uv")
        .args(["run", "--no-project", "--python"])
        .arg(&python)
        .args(["python", "-"])
        .arg(&row.dir)
        .arg(&row.name)
        .args(args)
        .current_dir(&row.dir)
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|source| Error::Spawn {
            program: "uv run".to_owned(),
            source,
        })?;
    child
        .stdin
        .as_mut()
        .ok_or(Error::MissingBridgeStdin)?
        .write_all(PYTHON_BRIDGE.as_bytes())
        .map_err(Error::WriteBridge)?;
    let status = child.wait().map_err(|source| Error::Spawn {
        program: "uv run".to_owned(),
        source,
    })?;
    Ok(exit_code(status))
}

fn exit_code(status: std::process::ExitStatus) -> i32 {
    status.code().unwrap_or(1)
}

fn discover_rows() -> Vec<ToolRow> {
    discover_rows_from_roots(candidate_roots())
}

fn discover_rows_from_roots(roots: Vec<PathBuf>) -> Vec<ToolRow> {
    let mut rows = std::collections::BTreeMap::<String, ToolRow>::new();
    for root in roots {
        for dir in tool_candidate_dirs(&root) {
            let Some(runner) = runner_for_dir(&dir) else {
                continue;
            };
            let name = dir
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_default();
            let kind = runner_kind(&runner);
            let commands = extract_commands(&runner).unwrap_or_default();
            let row = ToolRow {
                summary: extract_summary(&runner).unwrap_or_else(|_| "CLI tool".to_owned()),
                command_count: commands.len(),
                kind,
                runner,
                commands,
                dir,
                name: name.clone(),
            };
            rows.insert(name, row);
        }
    }
    rows.into_values().collect()
}

fn candidate_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let pwd = std::env::var_os("PWD")
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok());
    if let Some(pwd) = pwd {
        push_if_dir(&mut roots, pwd.join("tools"));
    }

    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        push_if_dir(&mut roots, home.join("workspace").join("tools"));
    }

    if let Some(tool_dirs) = std::env::var_os("TOOL_DIRS") {
        for dir in std::env::split_paths(&tool_dirs) {
            push_if_dir(&mut roots, dir);
        }
    }

    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let github = home.join("github");
        push_if_dir(&mut roots, github.join("tools"));
        for org in sorted_child_dirs(&github) {
            push_if_dir(&mut roots, org.join("tools"));
            for repo in sorted_child_dirs(&org) {
                push_if_dir(&mut roots, repo.join("tools"));
            }
        }
    }

    if let Some(overlay) = std::env::var_os("CENTAUR_OVERLAY_DIR").map(PathBuf::from) {
        push_if_dir(&mut roots, overlay.join("tools"));
    }

    roots
}

fn push_if_dir(roots: &mut Vec<PathBuf>, path: PathBuf) {
    if path.is_dir() {
        roots.push(path);
    }
}

fn sorted_child_dirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut dirs = entries
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    dirs.sort();
    dirs
}

fn tool_candidate_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for child in sorted_child_dirs(root) {
        dirs.push(child.clone());
        for grandchild in sorted_child_dirs(&child) {
            dirs.push(grandchild);
        }
    }
    dirs
}

fn find_tool_row(tool: &str) -> Option<ToolRow> {
    discover_rows()
        .into_iter()
        .find(|candidate| candidate.name == tool)
}

fn runner_for_dir(dir: &Path) -> Option<PathBuf> {
    ["cli", "cli.sh", "cli.js", "cli.py"]
        .into_iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file())
}

fn runner_kind(runner: &Path) -> RunnerKind {
    match runner.extension().and_then(OsStr::to_str) {
        Some("py") => RunnerKind::Python,
        Some("sh") => RunnerKind::Shell,
        Some("js") => RunnerKind::Node,
        _ => RunnerKind::Exec,
    }
}

fn extract_summary(runner: &Path) -> Result<String> {
    if runner_kind(runner) != RunnerKind::Python {
        return Ok("CLI tool".to_owned());
    }
    let contents = fs::read_to_string(runner).map_err(|source| Error::ReadFile {
        path: runner.to_path_buf(),
        source,
    })?;

    let typer_re = Regex::new(r#"(?s)typer\.Typer\s*\((.*?)\)"#).expect("valid typer regex");
    let double_help_re =
        Regex::new(r#"(?s)help\s*=\s*"([^"]*)""#).expect("valid double quote help regex");
    let single_help_re =
        Regex::new(r#"(?s)help\s*=\s*'([^']*)'"#).expect("valid single quote help regex");
    if let Some(args) = typer_re
        .captures(&contents)
        .and_then(|captures| captures.get(1))
    {
        let args = args.as_str();
        let help = double_help_re
            .captures(args)
            .and_then(|captures| captures.get(1))
            .or_else(|| {
                single_help_re
                    .captures(args)
                    .and_then(|captures| captures.get(1))
            });
        if let Some(help) = help {
            return Ok(normalize_summary(help.as_str()));
        }
    }

    let docstring_re = Regex::new(r#"(?s)\A\s*"""(.*?)""""#).expect("valid module docstring regex");
    if let Some(docstring) = docstring_re
        .captures(&contents)
        .and_then(|captures| captures.get(1))
    {
        return Ok(normalize_summary(docstring.as_str()));
    }

    Ok("CLI tool".to_owned())
}

fn normalize_summary(summary: &str) -> String {
    summary
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace(',', ";")
        .chars()
        .take(160)
        .collect()
}

fn extract_commands(runner: &Path) -> Result<Vec<String>> {
    if runner_kind(runner) != RunnerKind::Python {
        return Ok(Vec::new());
    }
    let contents = fs::read_to_string(runner).map_err(|source| Error::ReadFile {
        path: runner.to_path_buf(),
        source,
    })?;
    let decorator_re = Regex::new(r#"^\s*@\w+\.command\s*\(\s*(?:(?:"([^"]+)")|(?:'([^']+)'))?"#)
        .expect("valid command decorator regex");
    let def_re =
        Regex::new(r#"^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\("#).expect("valid function regex");
    let mut pending: Option<String> = None;
    let mut want = false;
    let mut commands = std::collections::BTreeSet::new();

    for line in contents.lines() {
        if let Some(captures) = decorator_re.captures(line) {
            pending = captures
                .get(1)
                .or_else(|| captures.get(2))
                .map(|value| value.as_str().to_owned());
            want = true;
            continue;
        }
        if want && let Some(def_name) = def_re.captures(line).and_then(|captures| captures.get(1)) {
            let command = pending
                .take()
                .unwrap_or_else(|| def_name.as_str().to_owned())
                .replace('_', "-");
            commands.insert(command);
            want = false;
        }
    }

    Ok(commands.into_iter().collect())
}

fn is_executable(path: &Path) -> bool {
    path.metadata()
        .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

fn python_env_dir(tool_name: &str, dir: &Path) -> Result<PathBuf> {
    let cache_home = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|home| home.join(".cache"))
        })
        .ok_or(Error::MissingHome)?;
    Ok(cache_home
        .join("centaur-tools")
        .join(format!("{tool_name}-{}", stable_path_key(dir))))
}

fn stable_path_key(path: &Path) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;

    let mut hash = FNV_OFFSET;
    for byte in path.as_os_str().as_encoded_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new(name: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "centaur-tools-{name}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn path(&self, path: &str) -> PathBuf {
            self.root.join(path)
        }

        fn write(&self, path: &str, contents: &str) -> PathBuf {
            let path = self.path(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, contents).unwrap();
            path
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn extracts_typer_help_and_commands() {
        let temp = TempTree::new("typer");
        let runner = temp.write(
            "tools/websearch/cli.py",
            r#"
import typer

app = typer.Typer(help="Search, summarize, and cite the web")

@app.command()
def deep_research():
    pass

@app.command("field-values")
def fields():
    pass
"#,
        );

        assert_eq!(
            extract_summary(&runner).unwrap(),
            "Search; summarize; and cite the web"
        );
        assert_eq!(
            extract_commands(&runner).unwrap(),
            vec!["deep-research".to_owned(), "field-values".to_owned()]
        );
    }

    #[test]
    fn discovers_depth_two_tools_and_overlay_wins() {
        let temp = TempTree::new("discover");
        temp.write("base/tools/base/websearch/cli.sh", "echo base\n");
        temp.write(
            "overlay/tools/overrides/websearch/cli.py",
            r#"app = typer.Typer(help="Overlay websearch")"#,
        );
        temp.write("overlay/tools/slack/cli.js", "console.log('ok')\n");

        let rows =
            discover_rows_from_roots(vec![temp.path("base/tools"), temp.path("overlay/tools")]);
        assert_eq!(
            rows.iter().map(|row| row.name.as_str()).collect::<Vec<_>>(),
            vec!["slack", "websearch",]
        );
        let websearch = rows.iter().find(|row| row.name == "websearch").unwrap();
        assert_eq!(websearch.kind, RunnerKind::Python);
        assert_eq!(websearch.summary, "Overlay websearch");
    }

    #[test]
    fn formats_list_output() {
        let temp = TempTree::new("list");
        temp.write("tools/slack/cli.js", "console.log('ok')\n");
        let rows = discover_rows_from_roots(vec![temp.path("tools")]);
        let mut out = format!("[{}]{{tool,type,commands,summary}}:\n", rows.len());
        for row in rows {
            out.push_str(&format!(
                "  {},{},{},{}\n",
                row.name,
                row.kind.as_str(),
                row.command_count,
                row.summary
            ));
        }
        assert_eq!(
            out,
            "[1]{tool,type,commands,summary}:\n  slack,node,0,CLI tool\n"
        );
    }

    #[test]
    fn stable_path_key_changes_with_path() {
        assert_ne!(
            stable_path_key(Path::new("/tmp/a")),
            stable_path_key(Path::new("/tmp/b"))
        );
        assert_eq!(
            stable_path_key(Path::new("/tmp/a")),
            stable_path_key(Path::new("/tmp/a"))
        );
    }
}
