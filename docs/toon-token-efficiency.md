# Token-Efficient Tool Responses with TOON

**Date:** 2025-02-28
**TL;DR:** We replaced verbose `curl` + JSON tool calls with a `call` helper + auto-selecting TOON/JSON encoding, saving **12% overall** and up to **53% on tabular data** — with zero regressions.

---

## The Problem

Our agent sandbox runs LLM harnesses (Amp, Claude Code, Codex) inside Docker containers. These agents call ~60+ API tools via REST. Every tool call has two sources of token waste:

1. **Command overhead** — the agent writes out a full curl command every time:
   ```bash
   curl -s -X POST -H "Content-Type: application/json" -d '{"per_page":5}' "$AI_V2_API_URL/tools/coingecko/get_markets"
   ```
   That's ~112 chars of boilerplate per call.

2. **Response format** — JSON repeats every key on every row. A list of 200 Slack channels repeats `"id"`, `"name"`, `"purpose"`, `"topic"`, `"member_count"`, `"is_private"`, `"is_member"` on every single object.

Both eat into the context window. Over an 8-call session, that's ~900 chars of wasted command tokens alone.

## The Solution

Three changes, layered:

### 1. `call.sh` — Concise Command Wrapper

Installed at `/usr/local/bin/call` in the agent container:

```bash
# Before
curl -s -X POST -H "Content-Type: application/json" -d '{"per_page":5}' "$AI_V2_API_URL/tools/coingecko/get_markets"

# After
call coingecko get_markets '{"per_page":5}'
```

Also handles search, SQL, and tool discovery:
```bash
call search "recent HYPE transfers" 10
call sql "SELECT source, COUNT(*) FROM raw_records GROUP BY source"
call discover arkham
```

The script sends `Accept: text/plain` so the API returns raw TOON instead of a JSON wrapper (`{"tool":"...","method":"...","result":"..."}`).

**Savings:** ~73 chars per invocation × 8 calls/session = ~584 chars

### 2. TOON Encoding with Pre-Flattening

[TOON](https://github.com/toon-format/spec) (Token-Oriented Object Notation) is a line-oriented format designed for LLM consumption. Its killer feature: **tabular encoding** for arrays of uniform objects.

**JSON (200 Slack channels):**
```json
[{"id":"C0AD58YA3TN","name":"hackathon","purpose":"","topic":"","member_count":2,"is_private":false,"is_member":false},{"id":"C0AAZJ8G45B","name":"offsite-info","purpose":"A hub to ask...","topic":"","member_count":63,"is_private":false,"is_member":false},...]
```

**TOON tabular (same data):**
```
[200]{id,name,purpose,topic,member_count,is_private,is_member}:
  C0AD58YA3TN,hackathon,"","",2,false,false
  C0AAZJ8G45B,offsite-info,A hub to ask...,"",63,false,false
  ...
```

Field names declared **once** in the header. Each row is just comma-separated values. This is where the 53% savings comes from.

**The catch:** TOON's tabular mode only activates when every element is a dict with identical keys and all-primitive values. One nested dict or list in any row disqualifies the entire array.

Example: CoinGecko's `/markets` endpoint returns coins with a `roi` field — it's `null` for most coins but a nested `{"times": 38.18, "currency": "btc", "percentage": 3818.96}` for ETH. That one field forced the entire 10-coin array into verbose list-item format.

**Fix: pre-flatten nested values before encoding:**

```python
def _flatten_for_tabular(data):
    """Stringify nested dicts/lists so arrays qualify for tabular TOON."""
    if not isinstance(data, list) or not data:
        return data
    if not all(isinstance(item, dict) for item in data):
        return data
    keys = set(data[0].keys())
    if not all(set(d.keys()) == keys for d in data):
        return data
    has_nested = any(
        isinstance(v, (dict, list)) for item in data for v in item.values()
    )
    if not has_nested:
        return data
    flat = []
    for item in data:
        row = {}
        for k, v in item.items():
            if isinstance(v, (dict, list)):
                row[k] = json.dumps(v, separators=(",", ":"), default=str)
            else:
                row[k] = v
        flat.append(row)
    return flat
```

The nested `roi` dict becomes the inline string `{"times":38.18,"currency":"btc","percentage":3818.96}` — one cell in a tabular row instead of three indented lines.

**Result on CoinGecko markets (10 coins):**
- Without flattening: 4,380 bytes (list-item format, keys repeated per coin)
- With flattening: 4,329 bytes → actually **tabular** now
- vs raw JSON: 8,002 bytes → **45% savings**

### 3. Auto-Select: TOON vs Compact JSON

TOON isn't always smaller. For deeply nested, non-uniform data (CoinGecko trending has `{coins: [...], nfts: [...], categories: [...]}` with varying schemas), TOON's indentation overhead exceeds JSON's braces.

We measured TOON being **17% larger** than JSON for trending data.

**Fix: compare both and pick the winner:**

```python
def _to_toon(data):
    try:
        toon = toon_encode(_flatten_for_tabular(data))
        compact_json = json.dumps(data, separators=(",", ":"), default=str)
        return toon if len(toon) <= len(compact_json) else compact_json
    except Exception:
        return json.dumps(data, default=str)
```

This guarantees **zero regressions** — worst case is 0% savings (we fall back to JSON).

## Results

Benchmark across 8 real tool integrations, measuring compact JSON vs auto-selected best format:

| Tool | JSON | Best | Savings | Format |
|------|------|------|---------|--------|
| slack/list_channels | 27,705 | 12,875 | **53%** | TOON tabular |
| coingecko/get_markets (10) | 8,002 | 4,337 | **45%** | TOON tabular |
| googlenews/search | 9,910 | 9,141 | **7%** | TOON |
| twitter/get_user | 630 | 606 | **3%** | TOON |
| coingecko/get_trending | 54,657 | 54,657 | 0% | JSON (nested) |
| kalshi/list_events | 33,997 | 33,997 | 0% | JSON (fallback) |
| twitter/search_tweets | 22,565 | 22,565 | 0% | JSON (tuple) |
| coingecko/get_price | 385 | 385 | 0% | JSON (flat) |
| **TOTAL** | **157,851** | **138,563** | **12%** | |

Plus ~584 chars/session from shorter commands.

## When TOON Wins Big

TOON's tabular format is most effective when:
- Data is an **array of objects** (lists, tables, search results)
- All objects have the **same keys** (uniform schema)
- Values are **primitives** (strings, numbers, booleans, nulls)
- There are **many rows** (amortizes the header cost)

This describes most API tool responses: Slack channels, market data, search results, user lists, transaction histories.

## When JSON Wins

JSON stays smaller when:
- Data is a **single deeply nested object** (TOON's indentation overhead > JSON's braces)
- Arrays have **non-uniform schemas** (different keys per object)
- Data is **already small** (< 500 chars — overhead is negligible)
- Return type is a **tuple** (common in Python APIs returning `(data, metadata)`)

## Key Takeaways

1. **Pre-flatten before encoding** — one nested field in an array disqualifies tabular TOON entirely. JSON-stringifying nested values restores tabular eligibility.

2. **Always compare formats** — never assume TOON is better. Measure both, pick the smaller one. Cost: one extra `json.dumps` call per response (negligible).

3. **Command-side savings compound** — a 73-char-shorter command template × N calls/session adds up. The `call.sh` wrapper also makes the system prompt smaller.

4. **Delimiter matters** — if your string values contain commas, use `toon_encode(data, {"delimiter": "|"})` to avoid over-quoting. We haven't needed this yet (comma delimiter works for our data).

5. **The TOON spec has features the Python lib doesn't** — key folding (`data.meta.items[2]: x,y`) could further compress deeply nested objects, but it's only in the TypeScript reference implementation as of v0.9.x.

## Implementation

- `sandbox/call.sh` — concise wrapper at `/usr/local/bin/call`
- `src/shared/tool_manager.py` — `_flatten_for_tabular()` + `_to_toon()` with auto-select
- `src/api/mcp_server.py` — same encoding for MCP responses
- `src/api/routers/search.py` — TOON support for search/SQL endpoints via `Accept: text/plain`
- REST tool endpoint returns raw TOON on `Accept: text/plain` instead of JSON wrapper

All changes: [feat: call.sh + toon](https://github.com/paradigmxyz/ai_v2/commit/aa7061c), [pre-flatten](https://github.com/paradigmxyz/ai_v2/commit/0446689), [auto-select](https://github.com/paradigmxyz/ai_v2/commit/b64ca96)
