# Tools API

Call any of Centaur's 60+ tool integrations via REST. Each tool is auto-discovered from the `tools/` directory and exposed as REST endpoints.

**Base URL:** `https://api.acme.com`

**Auth:** `X-Api-Key: $CENTAUR_API_KEY` or `Authorization: Bearer $CENTAUR_API_KEY`

Tool discovery is scope-filtered. A key with `tools:*` can see every available
tool; a key with `tools:slack` can only discover and call the Slack tool.
Operators create scoped keys through the [Admin API](/api/admin).

---

## GET /tools

List all available tools with their descriptions and methods.

### Response

A JSON object keyed by tool name:

```json
{
  "websearch": {
    "description": "Web search via multiple providers",
    "methods": ["search"]
  },
  "slack": {
    "description": "Slack API client",
    "methods": ["get_channel_history", "send_message", "search_messages"]
  }
}
```

### Example

```bash
curl -s https://api.acme.com/tools \
  -H "X-Api-Key: $CENTAUR_API_KEY"
```

---

## GET /tools/\{name\}

Discover a specific tool's methods, their parameters, and descriptions. Use this to understand what a tool can do before calling it.

### Response

```json
{
  "name": "websearch",
  "description": "Web search via multiple providers",
  "methods": {
    "search": {
      "description": "Search the web for a query.",
      "parameters": {
        "query": {"type": "string", "required": true},
        "num_results": {"type": "integer", "required": false}
      }
    }
  }
}
```

### Example

```bash
curl -s https://api.acme.com/tools/websearch \
  -H "X-Api-Key: $CENTAUR_API_KEY"
```

---

## POST /tools/\{name\}/\{method\}

Call a tool method. The request body is a JSON object whose fields match the method's parameters.

### Request Body

A JSON object with the method's parameters. Refer to `GET /tools/{name}` to discover available parameters.

### Response

A JSON object with the method's return value.

:::note[Response Format]
By default, tool responses return structured JSON. Sandbox agents (which send `Accept: text/plain`) receive TOON format for token efficiency. External callers always get clean JSON.
:::

### Example

```bash
# Search the web
curl -s -X POST https://api.acme.com/tools/websearch/search \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{"query": "latest ethereum news", "num_results": 3}'
```

```bash
# Get top Hacker News stories
curl -s -X POST https://api.acme.com/tools/hackernews/top_stories \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{"limit": 5}'
```

---

## Chart tool

Use `POST /tools/chart/render_chart` when a tool, workflow, app, or agent
needs image output. The method returns base64 PNG bytes in `result`.

```bash
curl -s -X POST https://api.acme.com/tools/chart/render_chart \
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
    "y": "runs"
  }'
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

---

## Full Example: Discover and Call

```bash
# 1. List all tools
curl -s https://api.acme.com/tools \
  -H "X-Api-Key: $CENTAUR_API_KEY"

# 2. Discover a specific tool's methods and parameters
curl -s https://api.acme.com/tools/slack \
  -H "X-Api-Key: $CENTAUR_API_KEY"

# 3. Call a method
curl -s -X POST https://api.acme.com/tools/slack/get_channel_history \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{"channel": "general", "limit": 5}'
```
