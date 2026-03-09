FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl \
    ripgrep fd-find jq yq tree gettext-base \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.7 /uv /uvx /usr/local/bin/

ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy

WORKDIR /app

# 1. Install core dependencies from pyproject metadata.
#    `uv.lock` is intentionally git-ignored in this repo, so we cannot rely on
#    it being present in clean checkouts or CI workspaces.
COPY pyproject.toml README.md ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --no-install-project --no-dev

# 2. Install project with source
COPY src/ src/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --no-dev

# 3. Install tool dependencies via bind mount (doesn't create a layer from tools/)
#    The uv cache mount means even on rebuild this is fast.
#    Scans both tools/ and tools-paradigm/ for pyproject.toml deps.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=tools,target=/tmp/tools \
    --mount=type=bind,source=tools-paradigm,target=/tmp/tools-paradigm \
    python -c "\
import tomllib, pathlib; \
deps = set(); \
[deps.update(tomllib.load(open(p,'rb')).get('project',{}).get('dependencies',[])) \
 for p in list(pathlib.Path('/tmp/tools').glob('*/pyproject.toml')) + \
          list(pathlib.Path('/tmp/tools-paradigm').glob('*/pyproject.toml'))]; \
open('/tmp/pd.txt','w').write('\n'.join(sorted(deps)))" \
    && uv pip install -r /tmp/pd.txt --quiet \
    && rm /tmp/pd.txt

# 4. Copy tool source (bind-mounted at runtime via docker-compose.yml,
#    but baked in for standalone image usage). Tool directories are
#    configured at runtime via TOOL_DIRS env var (colon-separated).
COPY tools/ tools/

# 5. Copy legal policy/docs used by tools
COPY docs/ docs/

# 6. Copy persona overlay prompts used by API harness runtime
COPY sandbox/SYSTEM_PROMPT_ENG.md sandbox/SYSTEM_PROMPT_LEGAL.md sandbox/

# Copy migrations
COPY migrations/ migrations/

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/app/.venv/bin/uvicorn", "api.app:app", "--host", "0.0.0.0", "--port", "8000"]
