#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  centaur-tools list
  centaur-tools discover <tool>
  centaur-tools run <tool> [args...]

Lists and runs local CLI tools from mounted tools/**/cli.py directories.
EOF
}

candidate_roots() {
  [ -d "$PWD/tools" ] && printf '%s\n' "$PWD/tools"
  [ -d "$HOME/workspace/tools" ] && printf '%s\n' "$HOME/workspace/tools"
  for root in "$HOME"/github/*/centaur/tools "$HOME"/github/*/centaur-overlay/tools; do
    [ -d "$root" ] && printf '%s\n' "$root"
  done
  if [ -n "${CENTAUR_OVERLAY_DIR:-}" ] && [ -d "$CENTAUR_OVERLAY_DIR/tools" ]; then
    printf '%s\n' "$CENTAUR_OVERLAY_DIR/tools"
  fi
}

extract_summary() {
  local cli="$1"
  local summary
  summary="$(
    perl -0777 -ne '
      if (/typer\.Typer\s*\((.*?)\)/s && $1 =~ /help\s*=\s*(["'"'"'"])(.*?)\1/s) {
        $s = $2;
      } elsif (/\A\s*"""(.*?)"""/s) {
        $s = $1;
      } else {
        exit;
      }
      $s =~ s/\s+/ /g;
      $s =~ s/,/;/g;
      print substr($s, 0, 160);
    ' "$cli"
  )"
  printf '%s' "${summary:-CLI tool}"
}

extract_commands() {
  local cli="$1"
  perl -ne '
    if (/^\s*@\w+\.command\s*\(\s*(?:(["'"'"'"])([^"'"'"'"]+)\1)?/) {
      $pending = $2 // "";
      $want = 1;
      next;
    }
    if ($want && /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/) {
      $cmd = $pending || $1;
      $cmd =~ s/_/-/g;
      print "$cmd\n";
      $want = 0;
    }
  ' "$cli" | sort -u
}

discover_rows() {
  candidate_roots | while IFS= read -r root; do
    find "$root" -mindepth 1 -maxdepth 3 -type f -name cli.py 2>/dev/null
  done | while IFS= read -r cli; do
    local dir tool summary commands command_count
    dir="$(dirname "$cli")"
    tool="$(basename "$dir")"
    summary="$(extract_summary "$cli")"
    commands="$(extract_commands "$cli" | paste -sd, -)"
    command_count="$(awk -v cmds="$commands" 'BEGIN { if (cmds == "") print 0; else print split(cmds, arr, ",") }')"
    printf '%s\t%s\t%s\t%s\t%s\n' "$tool" "$dir" "$summary" "$commands" "$command_count"
  done | awk -F '\t' '{ rows[$1] = $0 } END { for (tool in rows) print rows[tool] }' | sort -t "$(printf '\t')" -k1,1
}

find_tool_row() {
  local tool="$1"
  discover_rows | awk -F '\t' -v tool="$tool" '$1 == tool {print; found=1; exit} END {exit found ? 0 : 1}'
}

list_tools() {
  local rows count
  rows="$(discover_rows)"
  count="$(printf '%s\n' "$rows" | sed '/^$/d' | wc -l | tr -d ' ')"
  printf '[%s]{tool,commands,summary}:\n' "$count"
  printf '%s\n' "$rows" | awk -F '\t' 'NF {printf "  %s,%s,%s\n", $1, $5, $3}'
}

discover_tool() {
  local tool="$1"
  local row name dir summary commands count
  if ! row="$(find_tool_row "$tool")"; then
    printf '{"error":"unknown_tool","tool":"%s"}\n' "$tool"
    return 1
  fi
  IFS=$'\t' read -r name dir summary commands count <<<"$row"
  printf 'tool: %s\n' "$name"
  printf 'summary: %s\n' "$summary"
  printf 'dir: %s\n' "$dir"
  printf 'run: centaur-tools run %s <command> [args...]\n' "$name"
  printf '[%s]{command}:\n' "$count"
  printf '%s' "$commands" | tr ',' '\n' | sed '/^$/d; s/^/  /'
  printf '\n'
}

run_tool() {
  local tool="$1"
  shift || true
  local row name dir _summary _commands _count
  if ! row="$(find_tool_row "$tool")"; then
    printf '{"error":"unknown_tool","tool":"%s"}\n' "$tool"
    return 1
  fi
  IFS=$'\t' read -r name dir _summary _commands _count <<<"$row"
  cd "$dir"
  local env_dir path_key
  path_key="$(printf '%s' "$dir" | cksum | awk '{print $1}')"
  env_dir="${XDG_CACHE_HOME:-$HOME/.cache}/centaur-tools/${name}-${path_key}"
  mkdir -p "$(dirname "$env_dir")"
  uv venv --quiet --allow-existing "$env_dir"
  uv pip install --python "$env_dir/bin/python" --quiet -r pyproject.toml
  exec uv run --no-project --python "$env_dir/bin/python" python - "$dir" "$name" "$@" <<'PY'
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
PY
}

command="${1:-list}"
case "$command" in
  list|"")
    list_tools
    ;;
  discover)
    [ $# -ge 2 ] || { usage >&2; exit 2; }
    discover_tool "$2"
    ;;
  run)
    [ $# -ge 2 ] || { usage >&2; exit 2; }
    tool="$2"
    shift 2
    run_tool "$tool" "$@"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
