# Tools

Drop tool directories here. Each tool needs:

```
tools/
  my-tool/
    pyproject.toml   # [tool.centaur] section with module path
    .env.example     # Document required secrets
    __init__.py
    client.py        # API client class + _client() factory
    cli.py           # typer CLI for standalone use
```

## Writing a tool

```python
# client.py
from centaur.tool_sdk import secret


class MyClient:
    def search(self, query: str, limit: int = 10) -> dict:
        """Search something."""
        token = secret("MY_API_TOKEN")
        # ... use token, return results ...
        return {"results": [...]}


def _client() -> MyClient:
    return MyClient()
```

## Packaging CLI tools

Python CLIs must be real Python packages with console-script entrypoints. The
sandbox runner does not import `cli.py` by path or scrape dependencies from
`pyproject.toml`; it runs the package entrypoint with `uv tool run`.

Use a collision-safe internal package name so tool commands like `slack` do not
fight vendor packages that expose the same top-level import:

```toml
[project.scripts]
my-tool = "centaur_tool_my_tool.cli:app"

[tool.hatch.build.targets.wheel]
packages = ["."]

[tool.hatch.build.targets.wheel.sources]
"." = "centaur_tool_my_tool"
```

The command name should match the tool directory name. Keep `cli.py` as a Typer
app named `app`.

Rust CLIs can be mounted as a tool directory with `Cargo.toml`; `centaur-tools`
runs them with `cargo run` and keeps `CARGO_TARGET_DIR` under its cache. Go CLIs
can be mounted as a tool directory with `go.mod`; `centaur-tools` runs them with
`go run -mod=readonly` and keeps `GOCACHE`/`GOMODCACHE` under its cache.

## Dynamic mounting

CLI tools do not need to be baked into the sandbox image. Mount one or more tool
source roots read-only and expose them through `TOOL_DIRS`:

```bash
export TOOL_DIRS=/app/tools:/app/overlay/org/tools
centaur-tools list
centaur-tools run websearch search "latest account abstraction research"
```

`centaur-tools` also searches common workspace and `~/github/*/*/tools` roots,
so a sandbox can use base or overlay tools that are mounted beside the working
repo. The sandbox image only needs the language toolchains (`uv`, Rust, Go,
Node, shell); the CLI inventory comes from mounted source.

On Kubernetes, enable the Helm `repoCache` DaemonSet to keep configured GitHub
repositories synced into the node-local repo cache and mount that cache into
sandboxes at `~/github`. By default repo-cache authenticates through the shared
iron-proxy GitHub credential using `gh auth setup-git`, so operators do not need
to configure a separate GitHub PAT for the cache. Set
`repoCache.authMode=github-token` only when you explicitly want the repo-cache
pod to mount its own GitHub token Secret.

For faster cold-starts from mounted source, enable
`sandbox.toolBuildCache.enabled=true`. Centaur mounts the configured node-local
hostPath at `/home/agent/.cache` and points Python (`uv`), Rust (`cargo`), and
Go (`go`) at that cache. The first execution of a source-mounted tool still pays
the dependency/build cost; later executions on the same node reuse package,
module, and build artifacts across sandbox pods. This cache is a shared writable
hostPath, so production deployments should enable it only when that isolation
tradeoff is acceptable.

## Secrets

Secrets are resolved in this order:
1. **Tool `.env`** — per-tool overrides in `tools/<name>/.env`
2. **Root `.env`** — central file at repo root (define all secrets here)
3. **Environment variables** — for Docker, k8s, sops, 1Password, etc.

Use `secret("KEY")` to access. Never use `os.environ` — tool secrets are scoped.

## Available Plugins

The open-source tool inventory lives in this `tools/` tree and changes over time. To see what ships in the current repo, inspect the directories here or run Centaur and call `call tools` from a sandbox session.

Private deployments may mount additional overlay tool directories, so a running Centaur instance can expose more tools than are present in this repo.
