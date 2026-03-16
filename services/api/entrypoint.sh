#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# API container entrypoint — bootstrap secrets then exec the command.
#
# The secrets container shares this Dockerfile but overrides entrypoint in
# docker-compose.yml so it never runs this script.
# ---------------------------------------------------------------------------

source /app/scripts/bootstrap-secrets.sh

bootstrap_required_secrets DATABASE_URL SLACK_SIGNING_SECRET

# Install dependencies from bind-mounted tool directories (tools-paradigm, etc.)
# These aren't baked into the image — install at startup so tool loading doesn't fail.
if [[ -n "${TOOL_DIRS:-}" ]]; then
  IFS=':' read -ra _dirs <<< "$TOOL_DIRS"
  _extra_deps=""
  for _d in "${_dirs[@]}"; do
    [[ "$_d" == "/app/tools" ]] && continue  # already in image
    [[ -d "$_d" ]] || continue
    _extra_deps+=$(python3 -c "
import tomllib, pathlib
deps = set()
for p in pathlib.Path('$_d').glob('**/pyproject.toml'):
    deps.update(tomllib.load(open(p,'rb')).get('project',{}).get('dependencies',[]))
print('\n'.join(sorted(deps)))
" 2>/dev/null || true)
    _extra_deps+=$'\n'
  done
  if [[ -n "${_extra_deps}" ]]; then
    echo "$_extra_deps" | sort -u | grep -v '^$' > /tmp/_extra_deps.txt
    uv pip install -r /tmp/_extra_deps.txt --quiet 2>/dev/null || true
    rm -f /tmp/_extra_deps.txt
  fi
fi

# Canonical env aliases
if [[ -z "${SLACK_BOT_TOKEN:-}" && -n "${SLACK_TOKEN:-}" ]]; then
  export SLACK_BOT_TOKEN="${SLACK_TOKEN}"
fi
if [[ -z "${GITHUB_TOKEN:-}" && -n "${GH_TOKEN:-}" ]]; then
  export GITHUB_TOKEN="${GH_TOKEN}"
fi
if [[ -z "${GITHUB_TOKEN:-}" && -n "${GITHUB_PAT:-}" ]]; then
  export GITHUB_TOKEN="${GITHUB_PAT}"
fi
if [[ -z "${ANTHROPIC_API_KEY:-}" && -n "${ANTHROPIC_KEY:-}" ]]; then
  export ANTHROPIC_API_KEY="${ANTHROPIC_KEY}"
fi
if [[ -z "${ANTHROPIC_API_KEY:-}" && -n "${CLAUDE_API_KEY:-}" ]]; then
  export ANTHROPIC_API_KEY="${CLAUDE_API_KEY}"
fi

exec "$@"
