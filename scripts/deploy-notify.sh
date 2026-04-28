#!/usr/bin/env bash
# Post a deploy changelog to Slack.
# Uses OpenAI to summarize commits into a categorized changelog.
# On failure, posts the error and triggers the bot to auto-heal.
#
# Usage: scripts/deploy-notify.sh <before_sha> <after_sha> <components> <repo> [status] [error_log]
#
# Required env vars: OPENAI_API_KEY, SLACK_BOT_TOKEN, SLACK_DEPLOY_CHANNEL

set -euo pipefail

BEFORE="${1:?usage: deploy-notify.sh <before> <after> <components> <repo> [status] [error_log]}"
AFTER="${2:?}"
COMPONENTS="${3:?}"
REPO="${4:?}"
JOB_STATUS="${5:-success}"
ERROR_LOG="${6:-}"

SLACK_CHANNEL="${SLACK_DEPLOY_CHANNEL:?Set SLACK_DEPLOY_CHANNEL env var}"
CHANGED_FILES=$(git diff --name-only "${BEFORE}..${AFTER}" 2>/dev/null || true)

redeploy_venue_scout_if_needed() {
  if [ "${JOB_STATUS}" != "success" ]; then
    return 0
  fi

  if ! printf '%s\n' "${CHANGED_FILES}" | grep -q '^apps/venue-scout/'; then
    return 0
  fi

  echo "Redeploying venue-scout app from paradigmxyz/centaur/apps/venue-scout"

  local payload status response
  payload=$(jq -nc '{
    name: "venue-scout",
    repo_url: "https://github.com/paradigmxyz/centaur",
    port: 3000,
    build_cmd: "cd apps/venue-scout && npm install --no-package-lock && npm run build",
    start_cmd: "cd apps/venue-scout && npm start",
    created_by: "deploy-notify"
  }')

  status=$(docker exec centaur-api-1 sh -lc "curl -s -o /tmp/venue-scout-manage.json -w '%{http_code}' http://localhost:8000/apps/_manage/venue-scout")
  if [ "${status}" = "200" ]; then
    docker exec centaur-api-1 curl -sSf -X DELETE http://localhost:8000/apps/_manage/venue-scout > /dev/null
  elif [ "${status}" != "404" ]; then
    echo "Unexpected venue-scout lookup status: ${status}" >&2
    docker exec centaur-api-1 cat /tmp/venue-scout-manage.json >&2 || true
    exit 1
  fi

  printf '%s' "${payload}" | docker exec -i centaur-api-1 sh -lc \
    "curl -sSf -X POST http://localhost:8000/apps -H 'Content-Type: application/json' --data @-" > /dev/null

  for attempt in $(seq 1 60); do
    response=$(docker exec centaur-api-1 curl -sSf http://localhost:8000/apps/_manage/venue-scout)
    status=$(printf '%s' "${response}" | jq -r '.status // empty')
    echo "venue-scout status attempt ${attempt}: ${status}"

    if [ "${status}" = "running" ]; then
      curl -fsSI https://svc-ai.dayno.xyz/apps/venue-scout > /dev/null
      return 0
    fi

    if [ "${status}" = "failed" ]; then
      printf '%s\n' "${response}" | jq . >&2
      exit 1
    fi

    sleep 5
  done

  echo "Timed out waiting for venue-scout to reach running status" >&2
  exit 1
}

redeploy_venue_scout_if_needed

# Build commit list with links
COMMIT_JSON=$(git log --no-merges --format='%H %s' "${BEFORE}..${AFTER}" 2>/dev/null | while read -r sha msg; do
  short=$(echo "$sha" | cut -c1-7)
  pr=$(echo "$msg" | grep -oE '#[0-9]+' | head -1 | tr -d '#')
  if [ -n "$pr" ]; then
    url="https://github.com/${REPO}/pull/${pr}"
    link="<${url}|#${pr}>"
  else
    url="https://github.com/${REPO}/commit/${sha}"
    link="<${url}|${short}>"
  fi
  jq -n --arg sha "$short" --arg msg "$msg" --arg link "$link" \
    '{sha: $sha, message: $msg, link: $link}'
done | jq -s '.')

DIFFSTAT=$(git diff --stat "${BEFORE}..${AFTER}" 2>/dev/null | tail -20 || echo "")

# Ask LLM for a categorized changelog
PROMPT=$(cat <<'PROMPT_END'
You are a deploy-bot writing a Slack changelog. Group changes into categories using these exact headers:
• *Features* — new capabilities
• *Performance* — speed/efficiency improvements
• *Fixes* — bug fixes
• *Other* — refactors, docs, chores

Rules:
- Only include categories that have changes. Omit empty categories.
- Each item is a single bullet: "• <description> (<link>)" where <link> is the commit/PR link from the input.
- Keep descriptions short (under 15 words). Use plain language, no jargon.
- Use Slack formatting ONLY: *bold* for headers, no markdown.
- Output ONLY the categorized list, nothing else.
PROMPT_END
)
PROMPT="${PROMPT}

Components deployed:${COMPONENTS}

Commits (with links):
${COMMIT_JSON}

Diff stat:
${DIFFSTAT}"

SUMMARY=$(curl -sf https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg prompt "$PROMPT" '{
    model: "gpt-4o-mini",
    messages: [{role: "user", content: $prompt}],
    max_tokens: 500
  }')" | jq -r '.choices[0].message.content')

SHORT_SHA=$(echo "${AFTER}" | cut -c1-7)
COMPARE_URL="https://github.com/${REPO}/compare/${BEFORE}...${AFTER}"

# Build the message based on job status
if [ "$JOB_STATUS" = "failure" ]; then
  ERROR_BLOCK=""
  if [ -n "$ERROR_LOG" ]; then
    TRUNCATED_LOG=$(echo "$ERROR_LOG" | tail -30 | head -c 2500)
    ERROR_BLOCK=$(printf '\n\n*Error log:*\n```\n%s\n```' "$TRUNCATED_LOG")
  fi
  MSG=$(jq -n \
    --arg summary "$SUMMARY" \
    --arg sha "$SHORT_SHA" \
    --arg url "$COMPARE_URL" \
    --arg components "$COMPONENTS" \
    --arg error "$ERROR_BLOCK" \
    '{
      channel: "'"$SLACK_CHANNEL"'",
      text: (":x: *Deploy FAILED* —" + $components + " (<" + $url + "|" + $sha + ">)" + $error + "\n\n" + $summary),
      unfurl_links: false
    }')
else
  MSG=$(jq -n \
    --arg summary "$SUMMARY" \
    --arg sha "$SHORT_SHA" \
    --arg url "$COMPARE_URL" \
    --arg components "$COMPONENTS" \
    '{
      channel: "'"$SLACK_CHANNEL"'",
      text: (":rocket: *Deploy* —" + $components + " (<" + $url + "|" + $sha + ">)\n\n" + $summary),
      unfurl_links: false
    }')
fi

# Post the main message and capture the thread_ts for replies
RESPONSE=$(curl -sf -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$MSG")

# On failure, reply in the thread mentioning the bot to trigger auto-heal
if [ "$JOB_STATUS" = "failure" ]; then
  THREAD_TS=$(echo "$RESPONSE" | jq -r '.ts // empty')
  if [ -n "$THREAD_TS" ]; then
    BOT_USER_ID=$(curl -sf https://slack.com/api/auth.test \
      -H "Authorization: Bearer $SLACK_BOT_TOKEN" | jq -r '.user_id // empty')

    if [ -n "$BOT_USER_ID" ]; then
      HEAL_MSG="<@${BOT_USER_ID}> The CD pipeline just failed. Look at the error log above, check the recent commits at ${COMPARE_URL}, and figure out what went wrong. Then fix the issue — you have access to the repo. Push the fix to main so CD re-runs."

      curl -sf -X POST https://slack.com/api/chat.postMessage \
        -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
        -H "Content-Type: application/json" \
        -d "$(jq -n \
          --arg text "$HEAL_MSG" \
          --arg thread "$THREAD_TS" \
          '{
            channel: "'"$SLACK_CHANNEL"'",
            text: $text,
            thread_ts: $thread,
            unfurl_links: false
          }')" > /dev/null
    fi
  fi
fi
