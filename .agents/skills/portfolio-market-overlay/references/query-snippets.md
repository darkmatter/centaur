# Portfolio Market Overlay Reference

Reusable snippets for the `portfolio-market-overlay` skill.

## Token Aggregation Defaults

Apply these before querying direct exposure or balances:

- `HYPE` => `HYPE`, `HYPE_HYPERCORE`, `HYPE_HYPEREVM`
- `ETH` => `ETH`, `ETH_ARBITRUM`, `ETH_BASE`, `ETH_OPTIMISM`, `WETH`
- `MON` => `MON`, `MON_MONAD`
- `VANA` => `VANA`, `VANA_VANA`
- `OP` => `OP`, `OP_OPTIMISM`
- `USDC` => `USDC`, `USDC_SOLANA`

Defaults to preserve:

- `fund` => `PF` unless the user says otherwise
- `balances` => all custodians
- `ETH` => include staked unless the user asks for `available` or `liquid`
- `HYPE` => aggregate across chains unless the user asks for a specific chain

## Direct Exposure Query

Use `daily_performance_view` for the current portfolio screen.

```bash
call paradigmdb bq_query '{"query":"SELECT day, fundName, organizationName, assetTicker, holding, holdingMarketValue, liquidity, liquidityMarketValue FROM daily_performance_view WHERE day = CURRENT_DATE() AND assetTicker IN ('\''<TICKER_1>'\'', '\''<TICKER_2>'\'') ORDER BY holdingMarketValue DESC;"}'
```

If `CURRENT_DATE()` is empty, rerun with the latest available day:

```bash
call paradigmdb bq_query '{"query":"SELECT day, fundName, organizationName, assetTicker, holding, holdingMarketValue, liquidity, liquidityMarketValue FROM daily_performance_view WHERE day = (SELECT MAX(day) FROM daily_performance_view) AND assetTicker IN ('\''<TICKER_1>'\'', '\''<TICKER_2>'\'') ORDER BY holdingMarketValue DESC;"}'
```

## Proxy Exposure Query

Use this only when the user asks for proxy exposure or when direct exposure is zero and a same-project proxy is plausible.

```bash
call paradigmdb bq_query '{"query":"SELECT day, fundName, organizationName, assetName, assetTicker, assetType, holdingMarketValue, liquidityMarketValue FROM daily_performance_view WHERE day = (SELECT MAX(day) FROM daily_performance_view) AND organizationName ILIKE '\''%<ORG_NAME>%'\'' AND assetTicker NOT IN ('\''<TICKER_1>'\'', '\''<TICKER_2>'\'') ORDER BY holdingMarketValue DESC;"}'
```

If the project naming is ambiguous, resolve the organization first:

```bash
call paradigmdb db_organizations '{"search":"<PROJECT_NAME>","limit":10}'
```

## Custodian Balance Queries

Anchorage:

```bash
call paradigmdb bq_query '{"query":"SELECT fund_name, anchorage_vault_name, wallet_name, symbol, total_quantity, available_quantity, staked_quantity, unclaimed_quantity, total_usd_value FROM anchorage_balances_view WHERE symbol IN ('\''<TICKER_1>'\'', '\''<TICKER_2>'\'') ORDER BY total_usd_value DESC;"}'
```

Coinbase Prime:

```bash
call paradigmdb bq_query '{"query":"SELECT fund_name, coinbase_entity_name, wallet_name, symbol, amount, withdrawable_amount, bonded_amount, unbonding_amount, holds, pending_rewards_amount, fiat_amount FROM coinbase_balances_view WHERE symbol IN ('\''<TICKER_1>'\'', '\''<TICKER_2>'\'') ORDER BY fiat_amount DESC;"}'
```
`amount` is total. Do not add `bonded_amount`, `unbonding_amount`, or `holds` on top of it.

BitGo:

```bash
call paradigmdb bq_query '{"query":"SELECT enterprise_name, bitgo_organization_name, wallet_label, coin, total_balance, spendable_balance, locked_balance, staking_balance FROM bitgo_balances_view WHERE UPPER(coin) IN ('\''<TICKER_1>'\'', '\''<TICKER_2>'\'') ORDER BY total_balance DESC;"}'
```

Unit410:

```bash
call paradigmdb bq_query '{"query":"SELECT fund_name, wallet_account, wallet_network, symbol, total_amount, available_amount, delegated_amount, unbonding_amount, accrued_rewards_amount FROM unit410_balances_view WHERE symbol IN ('\''<TICKER_1>'\'', '\''<TICKER_2>'\'') ORDER BY total_amount DESC;"}'
```

HYPE staking override when chain-specific balances matter:

```bash
call paradigmdb db_query '{"query":"SELECT * FROM \"StakingOverride\" WHERE asset LIKE '\''%HYPE%'\'';"}'
```

## Market Overlay Queries

Resolve the internal asset id first:

```bash
call paradigmdb db_asset_by_symbol '{"symbol":"<TICKER>"}'
```

Internal daily prices:

```bash
call paradigmdb db_daily_prices '{"asset_id":"<ASSET_ID>","start_date":"2026-01-01"}'
```

Internal marks cross-check:

```bash
call paradigmdb bq_query '{"query":"SELECT date, ticker, datasource, exchange, price FROM marks_pricing_view WHERE ticker = '\''<TICKER>'\'' AND date >= DATE_SUB(CURRENT_DATE(), INTERVAL 35 DAY) ORDER BY date DESC;"}'
```

CoinGecko resolution and price series fallback:

```bash
call coingecko search '{"query":"<TOKEN_NAME>"}'
call coingecko get_market_chart '{"coin_id":"<COIN_ID>","vs_currency":"usd","days":365}'
call coingecko get_price '{"ids":"<COIN_ID>","vs_currencies":"usd","include_market_cap":true,"include_24hr_change":true}'
```

Use CoinMetrics for venue-aware candles when needed:

```bash
call coinmetrics get_market_candles '{"markets":"<EXCHANGE>-<BASE>-USD-SPOT","frequency":"1d","start_time":"2026-01-01"}'
```

## Threshold Guidance

Use these bands for the headline label:

- `0%` to `5%` below the reference high => `near highs`
- More than `5%` and up to `15%` below the reference high => `within range`
- More than `15%` below the reference high => `off highs`

Recommended comparisons:

- `30d high` for momentum screens
- `YTD high` for current-year context
- `ATH` or best available long-range high for ceiling context

When the user asks whether a token is `near highs`, prefer the strongest relevant statement, for example `4% below the YTD high and 18% below ATH`.

## Canned Output Checklist

Exposure check:

- one-sentence answer
- direct exposure totals
- custodian breakout
- proxy exposure note
- assumptions and freshness

High-watermark screen:

- one-sentence answer
- current price plus 30d, YTD, and ATH comparisons
- direct exposure totals
- custodian breakout if non-zero
- proxy exposure note if relevant
- assumptions and freshness
