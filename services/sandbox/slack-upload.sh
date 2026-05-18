#!/bin/bash
# slack-upload — upload a file to the current Slack thread
# Usage: slack-upload <file_path> [comment]
set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: slack-upload <file_path> [comment]" >&2
  exit 1
fi

FILE="$1"
COMMENT="${2:-}"

if [ ! -f "$FILE" ]; then
  echo "Error: file not found: $FILE" >&2
  exit 1
fi

CHANNEL="${SLACK_CHANNEL:?SLACK_CHANNEL not set}"
THREAD="${SLACK_THREAD_TS:?SLACK_THREAD_TS not set}"
FILENAME="$(basename "$FILE")"

extract_link() {
  local response="$1"
  local json_link
  json_link="$(printf '%s' "$response" | jq -r '.permalink // .file.permalink // empty' 2>/dev/null || true)"
  if [[ -n "$json_link" ]]; then
    printf '%s\n' "$json_link"
    return
  fi
  if [[ "$response" =~ (https://slack\.com/archives/[^[:space:]\"]+) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  fi
}

run_upload() {
  local body="$1"

  set +e
  RESP="$(call slack upload_file "$body" 2>&1)"
  STATUS=$?
  set -e

  LINK="$(extract_link "$RESP")"
}

B64="$(base64 < "$FILE" | tr -d '\n')"
BODY=$(jq -nc \
  --arg channel "$CHANNEL" \
  --arg content_base64 "$B64" \
  --arg filename "$FILENAME" \
  --arg title "$FILENAME" \
  --arg comment "$COMMENT" \
  --arg thread_ts "$THREAD" \
  '{channel: $channel, content_base64: $content_base64, filename: $filename, title: $title, comment: $comment, thread_ts: $thread_ts}')

run_upload "$BODY"
if [ "$STATUS" -eq 0 ] && [ -n "$LINK" ]; then
  echo "$LINK"
  exit 0
fi

echo "Error: upload failed" >&2
jq -nc \
  --arg file_path "$FILE" \
  --argjson status "$STATUS" \
  --arg response "$RESP" \
  '{error: "upload_failed", file_path: $file_path, status: $status, response: $response}' >&2
exit 1
