#!/usr/bin/env bash
# Capture real Amp SSE events exercising every sub-system:
#   - Built-in tools (Read, Grep, glob, finder, edit_file, Bash)
#   - Sub-agents (Task, oracle, librarian, look_at)
#   - Parallel sub-agents (3x and 5x Task calls)
#   - Handoff
#   - Skill loading
#   - Internal API tools via `call` (discover, search, tool methods)
#   - Interleaved: built-in tools + call-based API tools in same turn
#   - Web tools (web_search, read_web_page)
#   - Visual tools (mermaid)
#
# Usage: bash services/slackbot/src/lib/bot/capture-amp-events.sh

set -euo pipefail
FIXTURE_DIR="$(cd "$(dirname "$0")" && pwd)/fixtures"
rm -rf "$FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR"

HOST="ubuntu@206.223.235.69"
API="http://localhost:8000"
TS=$(date +%s)

capture() {
  local name="$1"
  local prompt="$2"
  local thread_key="test:cap-${TS}-${name}"
  echo "── $name"

  # Build the JSON payload locally (avoids shell quoting hell on the remote)
  local payload
  payload=$(python3 -c "import json,sys; print(json.dumps({'thread_key':'$thread_key','message':sys.stdin.read(),'harness':'amp'}))" <<< "$prompt")

  # Write payload to a temp file on the remote, curl from there
  ssh "$HOST" "cat > /tmp/cap-payload.json" <<< "$payload"
  ssh "$HOST" "docker cp /tmp/cap-payload.json centaur-api-1:/tmp/cap-payload.json" 2>/dev/null
  ssh "$HOST" "docker exec centaur-api-1 curl -sN -X POST '$API/agent/execute' \
    -H 'Content-Type: application/json' \
    -d @/tmp/cap-payload.json" \
    > "$FIXTURE_DIR/${name}.sse" 2>&1

  echo "   $(wc -l < "$FIXTURE_DIR/${name}.sse") lines"

  ssh "$HOST" "docker exec centaur-api-1 curl -s -X POST '$API/agent/stop' \
    -H 'Content-Type: application/json' \
    -d '{\"thread_key\": \"$thread_key\"}'" > /dev/null 2>&1 || true
  sleep 1
}

echo "Capturing from $HOST ($(date))..."
echo ""

# ── 1. Basic: text only ────────────────────────────────────────────────────
capture "simple-text" \
  "What is 2+2? One sentence, no tools."

# ── 2. Single built-in tool ───────────────────────────────────────────────
capture "single-tool" \
  "Read /home/agent/AGENTS.md and tell me the first line."

# ── 3. Multiple sequential built-in tools ─────────────────────────────────
capture "multi-tool-seq" \
  "Read /home/agent/AGENTS.md, then grep it for 'tool', then glob for /home/agent/workspace/services/**/*.py. Summarize each result in one line."

# ── 4. Parallel built-in tools (same response) ───────────────────────────
capture "parallel-tools" \
  "Do these IN PARALLEL in one response: 1) glob /home/agent/**/*.md 2) grep 'agent' in /home/agent/AGENTS.md 3) Read /home/agent/AGENTS.md lines 1-3. Then summarize."

# ── 5. Oracle sub-agent ──────────────────────────────────────────────────
capture "oracle" \
  "Use the oracle tool to review this Python function and suggest one improvement: def add(a, b): return a + b. Summarize the oracle response in one line."

# ── 6. Librarian sub-agent ───────────────────────────────────────────────
capture "librarian" \
  "Use the librarian tool to explain how normalizeHarnessEvent works in paradigmxyz/centaur. One paragraph max."

# ── 7. Single Task sub-agent ────────────────────────────────────────────
capture "single-task" \
  "Use the Task tool to count all Python files under /home/agent/workspace/services/api/. Report what the Task found."

# ── 8. 3 parallel Task sub-agents ───────────────────────────────────────
capture "three-parallel-tasks" \
  "Run exactly 3 Task sub-agents ALL IN PARALLEL in the same assistant message. Task 1: count lines in /home/agent/AGENTS.md. Task 2: list files in /home/agent/workspace/services/. Task 3: grep 'import' in /home/agent/workspace/services/api/api/app.py. After all 3, one-line summary of each."

# ── 9. 5 parallel Task sub-agents ───────────────────────────────────────
capture "five-parallel-tasks" \
  "Run exactly 5 Task sub-agents ALL IN PARALLEL in one response. Task 1: read first 3 lines of /home/agent/AGENTS.md. Task 2: glob /home/agent/workspace/services/**/*.py count results. Task 3: grep 'async def' in /home/agent/workspace/services/api/api/app.py. Task 4: read /home/agent/workspace/docker-compose.yml first 5 lines. Task 5: list /home/agent/workspace/tools/. One-line summary each after."

# ── 10. finder (semantic search) ────────────────────────────────────────
capture "finder" \
  "Use the finder tool to find where sandbox containers are spawned in the codebase. One paragraph."

# ── 11. Handoff ─────────────────────────────────────────────────────────
capture "handoff" \
  "Immediately use the handoff tool with follow=true and goal='Count lines in AGENTS.md'. Do nothing else first — just handoff."

# ── 12. Skill loading ──────────────────────────────────────────────────
capture "skill-load" \
  "Use the skill tool to load the 'code-review' skill. Then say 'Loaded successfully.' Do not review any code."

# ── 13. Internal API tools via call (discover) ─────────────────────────
capture "call-discover" \
  "Run this Bash command: call discover websearch — then summarize what methods are available."

# ── 14. Internal API tools via call (search) ───────────────────────────
capture "call-search" \
  "Run this Bash command: call search 'stablecoin regulation 2025' — then summarize the top result in one sentence."

# ── 15. Internal API tools via call (tool method) ──────────────────────
capture "call-tool-method" \
  "Run: call discover google-news — then run: call google-news search_news '{\"query\":\"bitcoin\",\"max_results\":2}' — summarize the results."

# ── 16. Interleaved: Read file THEN call API tool THEN grep ────────────
capture "interleaved-builtin-and-call" \
  "Do these steps in order: 1) Read /home/agent/AGENTS.md first 5 lines. 2) Then run Bash: call discover websearch. 3) Then grep 'Identity' in /home/agent/AGENTS.md. Summarize all three results."

# ── 17. Interleaved: parallel built-ins + call in same turn ────────────
capture "interleaved-parallel" \
  "Do ALL of these IN PARALLEL in one response: 1) Read /home/agent/AGENTS.md lines 1-3. 2) Bash: call discover slack. 3) grep 'tool' in /home/agent/AGENTS.md. 4) glob /home/agent/workspace/tools/**/*.py. Brief summary after."

# ── 18. Web search + read_web_page ─────────────────────────────────────
capture "web-tools" \
  "Use web_search to find 'Python asyncio tutorial'. Then use read_web_page on the first result. One sentence summary."

# ── 19. Mermaid diagram ────────────────────────────────────────────────
capture "mermaid" \
  "Use the mermaid tool to draw: flowchart LR; A-->B-->C. Then confirm done."

# ── 20. look_at ───────────────────────────────────────────────────────
capture "look-at" \
  "Use look_at to analyze /home/agent/AGENTS.md with objective 'List the main sections'. Brief answer."

# ── 21. Complex interleaved: Task + built-in + call in same turn ──────
capture "complex-interleaved" \
  "Do ALL of these: 1) Use Task tool to count .py files in /home/agent/workspace/services/api/. 2) IN PARALLEL with the Task, also Read /home/agent/AGENTS.md lines 1-5 and run Bash: call discover google-news. After all complete, summarize."

echo ""
echo "Done! $(ls "$FIXTURE_DIR"/*.sse | wc -l) fixtures captured."
ls -lhS "$FIXTURE_DIR/"
echo ""
echo "Replay: node --experimental-strip-types services/slackbot/src/lib/bot/replay-fixtures.ts"
