#!/bin/bash
# amp-wrapper.sh — PID 1 wrapper for amp in sandbox containers.
#
# Normally amp runs forever with --stream-json-input, reading turns from
# stdin.  The one exception: follow=true handoffs cause amp to exit after
# navigating to the new thread.  This wrapper detects that case and
# automatically runs `amp threads continue <newThreadID>` so the API sees
# one continuous stdout stream.
#
# When amp exits WITHOUT a handoff (error, clean shutdown, etc.), the
# wrapper exits too and the container stops — same as before.
#
# Usage: amp-wrapper [--model <model>]

set -uo pipefail

# Parse optional --model flag
MODEL_FLAGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --model) MODEL_FLAGS+=(--model "$2"); shift 2 ;;
        *) shift ;;
    esac
done

AMP_BASE=(amp --no-ide --no-notifications --dangerously-allow-all --execute --stream-json)
HANDOFF_FILE=/tmp/.handoff_thread

trap 'kill 0; exit 0' SIGTERM SIGINT

# stream_and_detect <cmd...>
# Runs a command, passes stdout through to the container, and watches
# for follow=true handoff events.  Writes the newThreadID to HANDOFF_FILE
# if found.
stream_and_detect() {
    rm -f "$HANDOFF_FILE"

    local fifo="/tmp/.amp_tee_$$"
    rm -f "$fifo"
    mkfifo "$fifo"

    # Background parser: reads tee'd copy of stdout, looks for handoff pattern.
    # Event sequence for a follow-handoff:
    #   1. assistant event with tool_use name=handoff, input.follow=true
    #   2. user event with tool_result containing newThreadID in content string
    (
        saw_follow=false
        while IFS= read -r line; do
            # Detect handoff tool_use with follow:true
            if [[ "$line" == *'"name":"handoff"'* ]] && [[ "$line" == *'"follow":true'* ]]; then
                saw_follow=true
            fi
            # Extract newThreadID from tool_result (content is JSON-encoded,
            # so on the wire it appears as \"newThreadID\":\"T-...\")
            if $saw_follow && [[ "$line" == *'newThreadID'* ]]; then
                tid=$(printf '%s' "$line" | sed -n 's/.*newThreadID[^T]*\(T-[a-f0-9-]*\).*/\1/p')
                if [[ -n "$tid" ]]; then
                    printf '%s' "$tid" > "$HANDOFF_FILE"
                    saw_follow=false
                fi
            fi
        done < "$fifo"
    ) &
    local parser_pid=$!

    # Run command — stdout tee'd to container stdout + parser FIFO
    "$@" | tee "$fifo"
    local exit_code=$?

    wait "$parser_pid" 2>/dev/null || true
    rm -f "$fifo"
    return $exit_code
}

# ── Phase 1: Run amp normally (reads turns from stdin) ───────────────────────
stream_and_detect "${AMP_BASE[@]}" ${MODEL_FLAGS[@]+"${MODEL_FLAGS[@]}"} --stream-json-input
amp_exit=$?

# ── Phase 2: Chain follow-handoffs until none remain ─────────────────────────
while [[ -f "$HANDOFF_FILE" ]]; do
    thread_id=$(cat "$HANDOFF_FILE")
    rm -f "$HANDOFF_FILE"
    [[ -z "$thread_id" ]] && break

    echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"continue"}]}}' \
      | stream_and_detect "${AMP_BASE[@]}" --stream-json-input \
          ${MODEL_FLAGS[@]+"${MODEL_FLAGS[@]}"} \
          threads continue "$thread_id"
    amp_exit=$?
done

exit "$amp_exit"
