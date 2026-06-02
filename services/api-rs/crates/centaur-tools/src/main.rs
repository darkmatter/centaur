use std::ffi::{OsStr, OsString};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

use clap::{CommandFactory, Parser, Subcommand};
use regex::Regex;
use serde_json::json;
use thiserror::Error;

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
    #[command(disable_help_flag = true)]
    Run {
        tool: String,
        #[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<OsString>,
    },
    /// Sync agent skills into the active workspace.
    Skills {
        #[command(subcommand)]
        command: SkillsCommand,
    },
    /// Print command help.
    Help,
}

#[derive(Debug, Subcommand)]
enum SkillsCommand {
    /// Copy skills into the active workspace once.
    Sync,
    /// Keep the active workspace skill copy fresh.
    Watch {
        #[arg(long, default_value_t = 30)]
        interval_seconds: u64,
    },
}

#[derive(Debug, Error)]
enum Error {
    #[error("failed to read {path}: {source}")]
    ReadFile {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to remove file {path}: {source}")]
    RemoveFile {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to rename {src} to {dst}: {source}")]
    Rename {
        src: PathBuf,
        dst: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to create {path}: {source}")]
    CreateDir {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to remove {path}: {source}")]
    RemoveDir {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to read directory {path}: {source}")]
    ReadDir {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to read entry in {path}: {source}")]
    ReadDirEntry {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to inspect {path}: {source}")]
    Metadata {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to copy {src} to {dst}: {source}")]
    CopyFile {
        src: PathBuf,
        dst: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to write {path}: {source}")]
    WriteFile {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to read link {path}: {source}")]
    ReadLink {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to symlink {src} to {dst}: {source}")]
    Symlink {
        src: PathBuf,
        dst: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to spawn {program}: {source}")]
    Spawn {
        program: String,
        source: std::io::Error,
    },
    #[error("failed to print help: {0}")]
    PrintHelp(std::io::Error),
    #[error("HOME is not set and XDG_CACHE_HOME was not provided")]
    MissingHome,
}

type Result<T> = std::result::Result<T, Error>;

const SOURCE_MARKER: &str = ".centaur-tools-source-key";
const FNV_OFFSET: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

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
    Go,
    Node,
    Python,
    Rust,
    Shell,
}

impl RunnerKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Exec => "exec",
            Self::Go => "go",
            Self::Node => "node",
            Self::Python => "python",
            Self::Rust => "rust",
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
        Commands::Skills { command } => run_skills_command(command),
        Commands::Help => {
            Cli::command().print_help().map_err(Error::PrintHelp)?;
            println!();
            Ok(0)
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SkillSyncConfig {
    home_dir: PathBuf,
    workspace_dir: PathBuf,
    overlay_dir: Option<PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SkillSyncReport {
    destination: PathBuf,
    sources: Vec<PathBuf>,
}

fn run_skills_command(command: SkillsCommand) -> Result<i32> {
    let config = skill_sync_config_from_env()?;
    match command {
        SkillsCommand::Sync => {
            let report = sync_skills(&config)?;
            println!(
                "{}",
                json!({
                    "ok": true,
                    "destination": report.destination,
                    "source_count": report.sources.len(),
                })
            );
            Ok(0)
        }
        SkillsCommand::Watch { interval_seconds } => {
            sync_skills(&config)?;
            if interval_seconds == 0 {
                return Ok(0);
            }
            loop {
                thread::sleep(Duration::from_secs(interval_seconds));
                sync_skills(&config)?;
            }
        }
    }
}

fn skill_sync_config_from_env() -> Result<SkillSyncConfig> {
    let home_dir = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or(Error::MissingHome)?;
    let state_dir = std::env::var_os("CENTAUR_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir.join("state"));
    let workspace_dir = if std::env::var("CENTAUR_PERSISTENT_STATE").as_deref() == Ok("1") {
        state_dir.join("workspace")
    } else {
        home_dir.join("workspace")
    };
    let overlay_dir = std::env::var_os("CENTAUR_OVERLAY_DIR").map(PathBuf::from);
    Ok(SkillSyncConfig {
        home_dir,
        workspace_dir,
        overlay_dir,
    })
}

fn sync_skills(config: &SkillSyncConfig) -> Result<SkillSyncReport> {
    let sources = skill_source_dirs(config);
    let ws_skills = config.workspace_dir.join(".agents").join("skills");
    let next_skills = ws_skills.with_file_name(format!(
        "{}.next.{}",
        ws_skills
            .file_name()
            .unwrap_or_else(|| OsStr::new("skills"))
            .to_string_lossy(),
        std::process::id()
    ));

    remove_path_if_exists(&next_skills)?;
    fs::create_dir_all(&next_skills).map_err(|source| Error::CreateDir {
        path: next_skills.clone(),
        source,
    })?;
    for source in &sources {
        copy_dir_contents(source, &next_skills)?;
    }

    if let Some(parent) = ws_skills.parent() {
        fs::create_dir_all(parent).map_err(|source| Error::CreateDir {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    remove_path_if_exists(&ws_skills)?;
    fs::rename(&next_skills, &ws_skills).map_err(|source| Error::Rename {
        src: next_skills.clone(),
        dst: ws_skills.clone(),
        source,
    })?;

    let claude_dir = config.workspace_dir.join(".claude");
    fs::create_dir_all(&claude_dir).map_err(|source| Error::CreateDir {
        path: claude_dir.clone(),
        source,
    })?;
    let claude_skills = claude_dir.join("skills");
    remove_path_if_exists(&claude_skills)?;
    std::os::unix::fs::symlink(&ws_skills, &claude_skills).map_err(|source| Error::Symlink {
        src: ws_skills.clone(),
        dst: claude_skills,
        source,
    })?;

    Ok(SkillSyncReport {
        destination: ws_skills,
        sources,
    })
}

fn skill_source_dirs(config: &SkillSyncConfig) -> Vec<PathBuf> {
    let mut sources = Vec::new();
    push_if_dir(&mut sources, config.home_dir.join(".agents").join("skills"));
    push_if_dir(&mut sources, config.home_dir.join("centaur-skills"));
    if let Some(centaur_skills) = first_centaur_repo_skills(&config.home_dir.join("github")) {
        sources.push(centaur_skills);
    }
    push_if_dir(&mut sources, config.home_dir.join("centaur-overlay-skills"));
    if let Some(overlay_dir) = &config.overlay_dir {
        push_if_dir(&mut sources, overlay_dir.join(".agents").join("skills"));
    }
    sources
}

fn first_centaur_repo_skills(github_dir: &Path) -> Option<PathBuf> {
    for org in sorted_child_dirs(github_dir) {
        for repo in sorted_child_dirs(&org) {
            if repo.file_name() != Some(OsStr::new("centaur")) {
                continue;
            }
            let skills = repo.join(".agents").join("skills");
            if skills.is_dir() {
                return Some(skills);
            }
        }
    }
    None
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
        RunnerKind::Rust => run_rust_tool(&row, &args),
        RunnerKind::Go => run_go_tool(&row, &args),
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
    let tool_dir = prepare_tool_source_dir("python-src", row)?;
    let executable = python_executable_name(row, &tool_dir);
    let mut command = Command::new("uv");
    command
        .args(["tool", "run", "--isolated", "--from"])
        .arg(&tool_dir);
    if let Some(sdk_path) = centaur_sdk_path(&tool_dir).or_else(|| centaur_sdk_path(&row.dir)) {
        command.arg("--with").arg(sdk_path);
    }
    let status = command
        .arg(executable)
        .args(args)
        .current_dir(&tool_dir)
        .status()
        .map_err(|source| Error::Spawn {
            program: "uv tool run".to_owned(),
            source,
        })?;
    Ok(exit_code(status))
}

fn python_executable_name(row: &ToolRow, tool_dir: &Path) -> String {
    let normalized_name = row.name.replace('_', "-");
    let Ok(contents) = fs::read_to_string(tool_dir.join("pyproject.toml")) else {
        return normalized_name;
    };
    let scripts = project_script_names(&contents);
    if scripts.iter().any(|script| script == &row.name) {
        return row.name.clone();
    }
    if scripts.iter().any(|script| script == &normalized_name) {
        return normalized_name;
    }
    if scripts.len() == 1 {
        return scripts[0].clone();
    }
    normalized_name
}

fn project_script_names(pyproject: &str) -> Vec<String> {
    let mut in_scripts = false;
    let mut scripts = Vec::new();
    for line in pyproject.lines() {
        let without_comment = line.split_once('#').map_or(line, |(prefix, _)| prefix);
        let trimmed = without_comment.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('[') {
            in_scripts = trimmed == "[project.scripts]";
            continue;
        }
        if !in_scripts {
            continue;
        }
        let Some((key, _value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim().trim_matches('"').trim_matches('\'');
        if !key.is_empty() {
            scripts.push(key.to_owned());
        }
    }
    scripts
}

fn prepare_tool_source_dir(kind: &str, row: &ToolRow) -> Result<PathBuf> {
    let tool_dir = tool_cache_dir(kind, &row.name, &row.dir)?;
    let source_key = source_tree_key(&row.dir)?;
    let marker = tool_dir.join(SOURCE_MARKER);
    if tool_dir.exists() {
        let existing_key = fs::read_to_string(&marker).ok();
        if existing_key.as_deref().map(str::trim) == Some(source_key.as_str()) {
            return Ok(tool_dir);
        }
        fs::remove_dir_all(&tool_dir).map_err(|source| Error::RemoveDir {
            path: tool_dir.clone(),
            source,
        })?;
    }
    copy_dir_all(&row.dir, &tool_dir)?;
    fs::write(&marker, source_key).map_err(|source| Error::WriteFile {
        path: marker,
        source,
    })?;
    Ok(tool_dir)
}

fn source_tree_key(root: &Path) -> Result<String> {
    let mut hash = FNV_OFFSET;
    update_source_tree_hash(root, root, &mut hash)?;
    Ok(format!("{hash:016x}"))
}

fn update_source_tree_hash(root: &Path, dir: &Path, hash: &mut u64) -> Result<()> {
    let entries = fs::read_dir(dir).map_err(|source| Error::ReadDir {
        path: dir.to_path_buf(),
        source,
    })?;
    let mut entries = entries
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|source| Error::ReadDirEntry {
            path: dir.to_path_buf(),
            source,
        })?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let rel = path.strip_prefix(root).unwrap_or(&path);
        hash_bytes(hash, rel.as_os_str().as_encoded_bytes());
        let file_type = entry.file_type().map_err(|source| Error::Metadata {
            path: path.clone(),
            source,
        })?;
        if file_type.is_dir() {
            hash_bytes(hash, b"dir");
            update_source_tree_hash(root, &path, hash)?;
        } else if file_type.is_symlink() {
            hash_bytes(hash, b"symlink");
            let target = fs::read_link(&path).map_err(|source| Error::ReadLink {
                path: path.clone(),
                source,
            })?;
            hash_bytes(hash, target.as_os_str().as_encoded_bytes());
        } else {
            hash_bytes(hash, b"file");
            let contents = fs::read(&path).map_err(|source| Error::ReadFile {
                path: path.clone(),
                source,
            })?;
            hash_bytes(hash, &contents);
        }
    }
    Ok(())
}

fn hash_bytes(hash: &mut u64, bytes: &[u8]) {
    for byte in bytes {
        *hash ^= u64::from(*byte);
        *hash = hash.wrapping_mul(FNV_PRIME);
    }
    *hash ^= 0xff;
    *hash = hash.wrapping_mul(FNV_PRIME);
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst).map_err(|source| Error::CreateDir {
        path: dst.to_path_buf(),
        source,
    })?;
    let entries = fs::read_dir(src).map_err(|source| Error::ReadDir {
        path: src.to_path_buf(),
        source,
    })?;
    for entry in entries {
        let entry = entry.map_err(|source| Error::ReadDirEntry {
            path: src.to_path_buf(),
            source,
        })?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        let file_type = entry.file_type().map_err(|source| Error::Metadata {
            path: src_path.clone(),
            source,
        })?;
        if file_type.is_dir() {
            copy_dir_all(&src_path, &dst_path)?;
        } else if file_type.is_symlink() {
            let target = fs::read_link(&src_path).map_err(|source| Error::ReadLink {
                path: src_path.clone(),
                source,
            })?;
            std::os::unix::fs::symlink(&target, &dst_path).map_err(|source| Error::Symlink {
                src: target,
                dst: dst_path,
                source,
            })?;
        } else {
            fs::copy(&src_path, &dst_path).map_err(|source| Error::CopyFile {
                src: src_path,
                dst: dst_path,
                source,
            })?;
        }
    }
    Ok(())
}

fn copy_dir_contents(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst).map_err(|source| Error::CreateDir {
        path: dst.to_path_buf(),
        source,
    })?;
    let entries = fs::read_dir(src).map_err(|source| Error::ReadDir {
        path: src.to_path_buf(),
        source,
    })?;
    for entry in entries {
        let entry = entry.map_err(|source| Error::ReadDirEntry {
            path: src.to_path_buf(),
            source,
        })?;
        copy_skill_entry(&entry.path(), &dst.join(entry.file_name()))?;
    }
    Ok(())
}

fn copy_skill_entry(src: &Path, dst: &Path) -> Result<()> {
    let file_type = fs::symlink_metadata(src).map_err(|source| Error::Metadata {
        path: src.to_path_buf(),
        source,
    })?;
    if file_type.is_dir() {
        if dst.exists() && !dst.is_dir() {
            remove_path_if_exists(dst)?;
        }
        fs::create_dir_all(dst).map_err(|source| Error::CreateDir {
            path: dst.to_path_buf(),
            source,
        })?;
        copy_dir_contents(src, dst)?;
    } else if file_type.is_symlink() {
        remove_path_if_exists(dst)?;
        let target = fs::read_link(src).map_err(|source| Error::ReadLink {
            path: src.to_path_buf(),
            source,
        })?;
        std::os::unix::fs::symlink(&target, dst).map_err(|source| Error::Symlink {
            src: target,
            dst: dst.to_path_buf(),
            source,
        })?;
    } else {
        remove_path_if_exists(dst)?;
        fs::copy(src, dst).map_err(|source| Error::CopyFile {
            src: src.to_path_buf(),
            dst: dst.to_path_buf(),
            source,
        })?;
    }
    Ok(())
}

fn remove_path_if_exists(path: &Path) -> Result<()> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(|source| Error::RemoveDir {
            path: path.to_path_buf(),
            source,
        })
    } else {
        fs::remove_file(path).map_err(|source| Error::RemoveFile {
            path: path.to_path_buf(),
            source,
        })
    }
}

fn run_rust_tool(row: &ToolRow, args: &[OsString]) -> Result<i32> {
    let tool_dir = prepare_tool_source_dir("rust-src", row)?;
    let target_dir = tool_cache_dir("cargo-target", &row.name, &row.dir)?;
    fs::create_dir_all(&target_dir).map_err(|source| Error::CreateDir {
        path: target_dir.clone(),
        source,
    })?;
    let manifest = tool_dir.join("Cargo.toml");
    let status = Command::new("cargo")
        .args(["run", "--quiet", "--manifest-path"])
        .arg(&manifest)
        .arg("--")
        .args(args)
        .current_dir(&tool_dir)
        .env("CARGO_TARGET_DIR", target_dir)
        .status()
        .map_err(|source| Error::Spawn {
            program: "cargo run".to_owned(),
            source,
        })?;
    Ok(exit_code(status))
}

fn run_go_tool(row: &ToolRow, args: &[OsString]) -> Result<i32> {
    let tool_dir = prepare_tool_source_dir("go-src", row)?;
    let cache_dir = tool_cache_dir("go", &row.name, &row.dir)?;
    let build_cache = cache_dir.join("build");
    let module_cache = cache_dir.join("mod");
    fs::create_dir_all(&build_cache).map_err(|source| Error::CreateDir {
        path: build_cache.clone(),
        source,
    })?;
    fs::create_dir_all(&module_cache).map_err(|source| Error::CreateDir {
        path: module_cache.clone(),
        source,
    })?;
    let status = Command::new("go")
        .args(["run", "-mod=readonly", "."])
        .args(args)
        .current_dir(&tool_dir)
        .env("GOCACHE", build_cache)
        .env("GOMODCACHE", module_cache)
        .status()
        .map_err(|source| Error::Spawn {
            program: "go run".to_owned(),
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
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let github = home.join("github");
        push_if_dir(&mut roots, github.join("tools"));
        for org in sorted_child_dirs(&github) {
            push_if_dir(&mut roots, org.join("tools"));
            for repo in sorted_child_dirs(&org) {
                push_if_dir(&mut roots, repo.join("tools"));
            }
        }
        push_if_dir(&mut roots, home.join("workspace").join("tools"));
    }

    let pwd = std::env::var_os("PWD")
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok());
    if let Some(pwd) = pwd {
        push_if_dir(&mut roots, pwd.join("tools"));
    }

    if let Some(tool_dirs) = std::env::var_os("TOOL_DIRS") {
        for dir in std::env::split_paths(&tool_dirs) {
            push_if_dir(&mut roots, dir);
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
    ["cli", "cli.sh", "cli.js", "cli.py", "Cargo.toml", "go.mod"]
        .into_iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file())
}

fn runner_kind(runner: &Path) -> RunnerKind {
    match runner.extension().and_then(OsStr::to_str) {
        Some("py") => RunnerKind::Python,
        Some("sh") => RunnerKind::Shell,
        Some("js") => RunnerKind::Node,
        Some("toml") if runner.file_name() == Some(OsStr::new("Cargo.toml")) => RunnerKind::Rust,
        Some("mod") if runner.file_name() == Some(OsStr::new("go.mod")) => RunnerKind::Go,
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

fn tool_cache_dir(kind: &str, tool_name: &str, dir: &Path) -> Result<PathBuf> {
    Ok(tool_cache_root()?
        .join(kind)
        .join(format!("{tool_name}-{}", stable_path_key(dir))))
}

fn tool_cache_root() -> Result<PathBuf> {
    let cache_home = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|home| home.join(".cache"))
        })
        .ok_or(Error::MissingHome)?;
    Ok(cache_home.join("centaur-tools"))
}

fn centaur_sdk_path(tool_dir: &Path) -> Option<PathBuf> {
    for ancestor in tool_dir.ancestors() {
        let candidate = ancestor.join("centaur_sdk");
        if is_python_package_dir(&candidate) {
            return Some(candidate);
        }
    }

    let mut roots = Vec::new();
    if let Some(pwd) = std::env::var_os("PWD").map(PathBuf::from) {
        roots.push(pwd);
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        roots.push(home.join("workspace"));
        let github = home.join("github");
        for org in sorted_child_dirs(&github) {
            roots.push(org.clone());
            for repo in sorted_child_dirs(&org) {
                roots.push(repo);
            }
        }
    }

    roots
        .into_iter()
        .map(|root| root.join("centaur_sdk"))
        .find(|candidate| is_python_package_dir(candidate))
}

fn is_python_package_dir(path: &Path) -> bool {
    path.join("pyproject.toml").is_file() && path.join("__init__.py").is_file()
}

fn stable_path_key(path: &Path) -> u64 {
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
    use std::process::Stdio;
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
    fn discovers_python_rust_and_go_tool_packages() {
        let temp = TempTree::new("polyglot");
        temp.write(
            "tools/pythonish/cli.py",
            "import typer\napp = typer.Typer()\n",
        );
        temp.write(
            "tools/rusty/Cargo.toml",
            r#"[package]
name = "rusty"
version = "0.1.0"
edition = "2021"
"#,
        );
        temp.write(
            "tools/gopher/go.mod",
            r#"module example.com/gopher

go 1.22
"#,
        );

        let rows = discover_rows_from_roots(vec![temp.path("tools")]);
        assert_eq!(
            rows.iter()
                .map(|row| (row.name.as_str(), row.kind))
                .collect::<Vec<_>>(),
            vec![
                ("gopher", RunnerKind::Go),
                ("pythonish", RunnerKind::Python),
                ("rusty", RunnerKind::Rust),
            ]
        );
    }

    #[test]
    fn runs_source_mounted_rust_cli() {
        if !command_available("cargo") {
            eprintln!("skipping Rust CLI proof because cargo is not installed");
            return;
        }

        let temp = TempTree::new("rust-run");
        let manifest = temp.write(
            "tools/rusty/Cargo.toml",
            r#"[package]
name = "rusty"
version = "0.1.0"
edition = "2021"
"#,
        );
        temp.write(
            "tools/rusty/src/main.rs",
            r#"fn main() {
    if std::env::args().nth(1).as_deref() == Some("ping") {
        println!("rust-ok");
    } else {
        std::process::exit(2);
    }
}
"#,
        );
        let row = ToolRow {
            name: "rusty".to_owned(),
            dir: temp.path("tools/rusty"),
            summary: "CLI tool".to_owned(),
            command_count: 0,
            kind: RunnerKind::Rust,
            runner: manifest,
            commands: Vec::new(),
        };

        assert_eq!(run_rust_tool(&row, &[OsString::from("ping")]).unwrap(), 0);
        assert!(!temp.path("tools/rusty/Cargo.lock").exists());
    }

    #[test]
    fn prepares_python_tool_from_cache_copy() {
        let temp = TempTree::new("python-cache");
        let runner = temp.write(
            "tools/pyhello/cli.py",
            r#"import typer

app = typer.Typer()

@app.command()
def main():
    print("ok")
"#,
        );
        temp.write(
            "tools/pyhello/pyproject.toml",
            r#"[project]
name = "pyhello"
version = "0.1.0"
dependencies = ["typer"]
"#,
        );
        let row = ToolRow {
            name: "pyhello".to_owned(),
            dir: temp.path("tools/pyhello"),
            summary: "CLI tool".to_owned(),
            command_count: 1,
            kind: RunnerKind::Python,
            runner,
            commands: vec!["main".to_owned()],
        };

        let prepared = prepare_tool_source_dir("python-src", &row).unwrap();
        assert_ne!(prepared, row.dir);
        assert!(prepared.join("cli.py").is_file());
        assert!(prepared.join("pyproject.toml").is_file());
        assert_eq!(
            fs::read_to_string(prepared.join("cli.py")).unwrap(),
            fs::read_to_string(row.dir.join("cli.py")).unwrap()
        );

        fs::write(prepared.join("sentinel"), "cached").unwrap();
        let prepared_again = prepare_tool_source_dir("python-src", &row).unwrap();
        assert_eq!(prepared_again, prepared);
        assert_eq!(
            fs::read_to_string(prepared_again.join("sentinel")).unwrap(),
            "cached"
        );

        fs::write(row.dir.join("cli.py"), "print('changed')\n").unwrap();
        let prepared_after_change = prepare_tool_source_dir("python-src", &row).unwrap();
        assert_eq!(prepared_after_change, prepared);
        assert!(!prepared_after_change.join("sentinel").exists());
        assert_eq!(
            fs::read_to_string(prepared_after_change.join("cli.py")).unwrap(),
            "print('changed')\n"
        );
        fs::remove_dir_all(prepared).unwrap();
    }

    #[test]
    fn resolves_python_executable_from_project_scripts() {
        let temp = TempTree::new("python-entrypoint");
        temp.write(
            "tools/acme_crm/pyproject.toml",
            r#"[project]
name = "acme-crm"

[project.scripts]
acme-crm = "centaur_tool_acme_crm.cli:main"
"#,
        );
        let row = ToolRow {
            name: "acme_crm".to_owned(),
            dir: temp.path("tools/acme_crm"),
            summary: "CLI tool".to_owned(),
            command_count: 0,
            kind: RunnerKind::Python,
            runner: temp.path("tools/acme_crm/cli.py"),
            commands: Vec::new(),
        };

        assert_eq!(python_executable_name(&row, &row.dir), "acme-crm");
    }

    #[test]
    fn syncs_overlay_skills_into_workspace_and_refreshes_changes() {
        let temp = TempTree::new("skills-sync");
        temp.write("home/.agents/skills/acme-support/SKILL.md", "base skill\n");
        temp.write(
            "home/github/paradigmxyz/centaur/.agents/skills/eng/SKILL.md",
            "centaur skill\n",
        );
        temp.write(
            "home/centaur-overlay-skills/acme-support/SKILL.md",
            "mounted org skill\n",
        );
        let overlay_skill = temp.write(
            "home/github/paradigmxyz/centaur-acme/.agents/skills/acme-support/SKILL.md",
            "overlay skill v1\n",
        );
        let config = SkillSyncConfig {
            home_dir: temp.path("home"),
            workspace_dir: temp.path("home/workspace"),
            overlay_dir: Some(temp.path("home/github/paradigmxyz/centaur-acme")),
        };

        let report = sync_skills(&config).unwrap();

        assert_eq!(
            report.sources,
            vec![
                temp.path("home/.agents/skills"),
                temp.path("home/github/paradigmxyz/centaur/.agents/skills"),
                temp.path("home/centaur-overlay-skills"),
                temp.path("home/github/paradigmxyz/centaur-acme/.agents/skills"),
            ]
        );
        assert_eq!(
            fs::read_to_string(temp.path("home/workspace/.agents/skills/acme-support/SKILL.md"))
                .unwrap(),
            "overlay skill v1\n"
        );
        assert_eq!(
            fs::read_to_string(temp.path("home/workspace/.agents/skills/eng/SKILL.md")).unwrap(),
            "centaur skill\n"
        );
        assert_eq!(
            fs::read_link(temp.path("home/workspace/.claude/skills")).unwrap(),
            temp.path("home/workspace/.agents/skills")
        );

        fs::write(overlay_skill, "overlay skill v2\n").unwrap();
        sync_skills(&config).unwrap();

        assert_eq!(
            fs::read_to_string(temp.path("home/workspace/.agents/skills/acme-support/SKILL.md"))
                .unwrap(),
            "overlay skill v2\n"
        );
    }

    #[test]
    fn parses_quoted_project_script_keys() {
        let scripts = project_script_names(
            r#"[project.scripts]
"acme.crm" = "pkg.cli:main"
'acme-alt' = "pkg.alt:main"

[tool.other]
ignored = "nope"
"#,
        );

        assert_eq!(scripts, vec!["acme.crm", "acme-alt"]);
    }

    #[test]
    fn runs_source_mounted_go_cli() {
        if !command_available("go") {
            eprintln!("skipping Go CLI proof because go is not installed");
            return;
        }

        let temp = TempTree::new("go-run");
        let manifest = temp.write(
            "tools/gopher/go.mod",
            r#"module example.com/gopher

go 1.22
"#,
        );
        temp.write(
            "tools/gopher/main.go",
            r#"package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "ping" {
		fmt.Println("go-ok")
		return
	}
	os.Exit(2)
}
"#,
        );
        let row = ToolRow {
            name: "gopher".to_owned(),
            dir: temp.path("tools/gopher"),
            summary: "CLI tool".to_owned(),
            command_count: 0,
            kind: RunnerKind::Go,
            runner: manifest,
            commands: Vec::new(),
        };

        assert_eq!(run_go_tool(&row, &[OsString::from("ping")]).unwrap(), 0);
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

    fn command_available(command: &str) -> bool {
        Command::new(command)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}
