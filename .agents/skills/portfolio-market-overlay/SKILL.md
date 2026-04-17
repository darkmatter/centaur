---
name: portfolio-market-overlay
description: "Builds a compact portfolio exposure screen using holdings, custodian balances, and market highs. Use when asked whether the firm has direct or proxy exposure to a token, which funds or custodians hold it, or whether a token is near 1m, YTD, or all-time highs. Triggers on: do we own, exposure check, proxy exposure, near highs, 1m high, YTD high, ATH screen."
---

# Portfolio Market Overlay

Builds a compact exposure screen that combines portfolio holdings with market context.

## Use When

- The user asks whether Paradigm has direct exposure to a token.
- The user asks for direct vs proxy exposure.
- The user asks which funds or custodians hold a token.
- The user wants a quick screen of holdings plus market context such as 1m highs, YTD highs, or all-time highs.
- The user wants a compact answer rather than a full memo.

Do not use this skill for trade approvals, full diligence writeups, or pure live-balance reconciliation with no market overlay.

## Defaults

- Fund default: `PF`. Expand only if the user asks for `all funds`, `ops`, or names another fund.
- Balance default: check all available custodian surfaces. Never assume a single custodian.
- Exposure default: check direct token exposure first, then obvious proxy exposure tied to the same `organizationName` when the user asks for proxy exposure or when direct exposure is zero.
- ETH means aggregate exposure across `ETH`, `ETH_ARBITRUM`, `ETH_BASE`, `ETH_OPTIMISM`, and `WETH` unless the user says `available` or `liquid`.
- HYPE means aggregate exposure across `HYPE`, `HYPE_HYPERCORE`, and `HYPE_HYPEREVM` unless the user names a specific chain.
- Apply the token aggregation rules in `references/query-snippets.md` before querying.
- State assumptions and source freshness in the final answer.

## Workflow

### 1. Resolve the asset and scope

- Identify the requested ticker, protocol, or project name.
- Expand the ticker into the correct alias set before querying. Use the aggregation map from `references/query-snippets.md`.
- If the user asks about `direct or proxy` exposure, keep those outputs separate.
- If the request is ambiguous about fund scope, default to `PF` and say so.

### 2. Check direct exposure in `daily_performance_view`

- Use `daily_performance_view` as the default portfolio exposure surface.
- Pull the latest day for the requested ticker set and include `fundName`, `holding`, `holdingMarketValue`, `liquidity`, and `liquidityMarketValue`.
- If there are no matching rows for `CURRENT_DATE()`, rerun on the latest available day and call out the date.
- Treat `holding` as total owned and `liquidity` as liquid or unlocked, consistent with the system prompt.

### 3. Add custodian breakout from balance views

- Use the `*_balances_view` tables to show where the position sits and how much is immediately available.
- Normalize each source into the same mental model: `total`, `available`, `staked`, `locked_or_holds`, `unbonding`, and `rewards` where relevant.
- Respect source-specific accounting rules:
  - Coinbase: `amount` is the total. Do not add `bonded_amount` or `holds` on top of it.
  - Anchorage: `total_quantity` already includes the staked component.
  - BitGo: `total_balance` is the total; `spendable_balance` is liquid.
  - Unit410: `total_amount` is the total; `available_amount` is liquid.
- If the user needs true live balances rather than reporting-view balances, discover and call the live custodian tools after the BQ screen.

### 4. Check proxy exposure when requested

- Proxy exposure is separate from direct token ownership.
- Start with `daily_performance_view` rows whose `organizationName` matches the project while `assetTicker` is outside the direct alias set.
- Use this for obvious same-project instruments such as equity, warrants, or related assets that share the organization mapping.
- If the project or token naming is ambiguous, resolve the organization with `call paradigmdb db_organizations '{"search":"<project>"}'` before running the proxy query.
- Label proxy findings as `proxy` or `possible proxy` rather than mixing them into direct holdings.

### 5. Pull the market overlay

- Resolve the internal asset first with `call paradigmdb db_asset_by_symbol`.
- If an internal asset exists, use `call paradigmdb db_daily_prices` to build the daily price series for `30d`, `YTD`, and longer lookbacks.
- If there is no internal asset or the internal series is incomplete, use CoinGecko:
  - `search` to resolve the coin id
  - `get_market_chart` for recent price history
  - `get_price` for the current price snapshot
- Use CoinMetrics only when the user needs venue-aware candles or CoinGecko is missing the market.
- Compute at least:
  - current price
  - 30d high and percent below it
  - YTD high and percent below it
  - all-time high or best available long-range high and percent below it

### 6. Return one of the two canned shapes

#### Exposure Check

Use this when the user mainly wants holdings and custody context.

Structure:

1. One-sentence answer first: direct exposure, proxy exposure, both, or none.
2. Direct exposure section with fund totals and liquid totals.
3. Custodian breakout with the source-specific caveat only where needed.
4. Proxy exposure section, clearly labeled.
5. Assumptions and date freshness.

Use a `dashboard` block when there are multiple funds, custodians, or tickers.

#### High-Watermark Screen

Use this when the user wants exposure plus market context.

Structure:

1. One-sentence answer first: whether we hold it and how close the asset is to highs.
2. Market snapshot with current price, 30d high, YTD high, ATH, and drawdowns.
3. Direct exposure table.
4. Custodian breakout if holdings are non-zero.
5. Proxy exposure note if relevant.
6. Assumptions, data sources, and freshness.

Use the threshold guidance from `references/query-snippets.md` to label `near highs`, `within range`, or `off highs`.

## Answering Rules

- Lead with the conclusion, then show the evidence.
- Keep direct and proxy exposure separate.
- If direct exposure is zero, say that plainly before discussing proxy exposure.
- If the user asked about highs and there is no exposure, still provide the market screen if it helps answer the question.
- When data sources disagree, prefer internal portfolio data for holdings and explain which market source supplied the price context.
- Avoid long prose. These asks are usually fast portfolio screens.

## Reference

Use `references/query-snippets.md` for the reusable query shapes, token aggregation map, and near-high threshold guidance.
