---
title: Step-by-Step API Guide
description: Configure a deployment URL, list tools, render a chart, run an agent, and stream output.
---

# Step-by-Step API Guide

Follow these steps in one shell. Each command builds on the variables created
before it.

If you have not configured Slack, GitHub, model credentials, and baseline
secrets yet, start with [Set Up Centaur](/setup).

## Step 1. Set your API URL and key

```bash
export CENTAUR_API_URL="https://api.acme.com"
export CENTAUR_API_KEY="aiv2_your_key_here"
```

If you manage the deployment, create this key through the
[Admin API](/api/admin) with the scopes your caller needs. For this guide, use
`["agent:execute", "tools:*"]`.

:::tip
Inside a Centaur-managed app or sandbox, use `http://api:8000` as
`CENTAUR_API_URL`. Internal callers are already on Centaur's private network
and may not need to send an API key.
:::

## Step 2. Check the API

```bash
curl -s "$CENTAUR_API_URL/health" \
  -H "X-Api-Key: $CENTAUR_API_KEY"
```

Expected shape:

```json
{"status":"ok"}
```

## Step 3. List the tools

Tools are REST methods generated from Python clients. Agents call the same
endpoints that you can call with curl.

```bash
curl -s "$CENTAUR_API_URL/tools" \
  -H "X-Api-Key: $CENTAUR_API_KEY" | python3 -m json.tool
```

Inspect one tool before calling it:

```bash
curl -s "$CENTAUR_API_URL/tools/websearch" \
  -H "X-Api-Key: $CENTAUR_API_KEY" | python3 -m json.tool
```

## Step 4. Call a tool directly

```bash
curl -s -X POST "$CENTAUR_API_URL/tools/websearch/search" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{"query":"Centaur agent infrastructure","num_results":3}' | python3 -m json.tool
```

Direct tool calls are best when your app already knows which API it needs. Use
an agent when you want Centaur to plan, choose tools, and write the final
answer.

## Step 5. Render a chart

The `chart` tool renders base64 PNG output through the shared
`centaur_charts` package.

```bash
curl -s -X POST "$CENTAUR_API_URL/tools/chart/render_chart" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{
    "chart_type": "line",
    "title": "Weekly agent runs increased",
    "data": [
      {"week": "2026-04-06", "runs": 42},
      {"week": "2026-04-13", "runs": 58},
      {"week": "2026-04-20", "runs": 73}
    ],
    "x": "week",
    "y": "runs",
    "source": "Centaur usage events"
  }' | python3 -c 'import json,sys; result=json.load(sys.stdin)["result"]; print(f"rendered chart: {len(result)} base64 chars")'
```

Supported canonical chart types:

| Family | Chart types |
|--------|-------------|
| Time series | `line`, `multi_line`, `indexed_line`, `slope`, `dumbbell`, `lollipop`, `area`, `stacked_area` |
| Comparison | `horizontal_bar`, `vertical_bar`, `grouped_bar`, `stacked_bar`, `stacked_bar_100`, `diverging_bar`, `bullet` |
| Distribution | `histogram`, `kde`, `box`, `violin`, `ridgeline`, `ecdf`, `lorenz` |
| Relationship | `scatter`, `bubble`, `hexbin`, `correlation_heatmap`, `connected_scatter` |
| Composition | `treemap`, `waterfall`, `pie`, `heatmap`, `calendar_heatmap` |
| Finance | `candlestick`, `drawdown`, `cumulative_returns`, `returns_histogram`, `risk_return`, `rolling_stat` |
| Layout | `sparkline`, `kpi_tile`, `big_number_with_sparkline`, `small_multiples` |

## Step 6. Spawn an agent session

The agent API is split into separate calls so Centaur can save each step. That
is what makes reconnects, cancellation, retries, and status checks work.

```bash
THREAD_KEY="docs-demo-$(date +%s)"

SPAWN=$(curl -s -X POST "$CENTAUR_API_URL/agent/spawn" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"harness\":\"amp\"}")

ASSIGNMENT_GENERATION=$(printf '%s' "$SPAWN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["assignment_generation"])')
```

## Step 7. Add the user message

```bash
curl -s -X POST "$CENTAUR_API_URL/agent/message" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"assignment_generation\":${ASSIGNMENT_GENERATION},\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"Use available tools if useful. Explain what Centaur is in three bullets.\"}]}"
```

## Step 8. Execute the turn

```bash
EXECUTE=$(curl -s -X POST "$CENTAUR_API_URL/agent/execute" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"assignment_generation\":${ASSIGNMENT_GENERATION},\"harness\":\"amp\",\"delivery\":{\"platform\":\"dev\"}}")

EXECUTION_ID=$(printf '%s' "$EXECUTE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["execution_id"])')
```

## Step 9. Stream events

```bash
curl -s -N "$CENTAUR_API_URL/agent/threads/${THREAD_KEY}/events?execution_id=${EXECUTION_ID}&after_event_id=0" \
  -H "X-Api-Key: $CENTAUR_API_KEY"
```

The stream is server-sent events. Keep the latest `event_id`; if the
connection drops, reconnect with `after_event_id=<last_seen_id>`.

## Step 10. Release the runtime

Release the assignment when the thread no longer needs the warm sandbox.

```bash
curl -s -X POST "$CENTAUR_API_URL/agent/threads/${THREAD_KEY}/release" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d "{\"release_id\":\"rel-${THREAD_KEY}\",\"cancel_inflight\":true}" | python3 -m json.tool
```

## What just happened

```diagram
╭────────╮   spawn/message/execute   ╭─────────────╮
│ curl   │──────────────────────────▶│ Centaur API │
╰────────╯                           ╰──────┬──────╯
                                            │ saved rows
                                            ▼
                                     ╭─────────────╮
                                     │ Sandbox     │
                                     │ agent CLI   │
                                     ╰──────┬──────╯
                                            │ tool REST calls
                                            ▼
                                     ╭─────────────╮
                                     │ Tool plugins│
                                     ╰─────────────╯
```

Next: deploy Centaur on your infrastructure with the [deployment guide](/tutorials/deploy).
