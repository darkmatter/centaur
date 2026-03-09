/** GET /api/portfolio/positions -> POST /tools/paradigmdb/db_query
 *
 * Fetches positions from PerformanceLatest joined with Asset + Fund,
 * enriched with latest CoinGecko prices. Results are cached for 5 min.
 */

import { resilientFetch, API_URL, ApiError } from "@/lib/bot/api-client";
import { decode } from "@toon-format/toon";

export const dynamic = "force-dynamic";

// ── In-memory cache (5 min TTL) ──

type CacheEntry = { data: Record<string, unknown>[]; ts: number };
let cache: CacheEntry | null = null;
const CACHE_TTL = 5 * 60 * 1000;

// ── SQL queries ──

const POSITIONS_SQL = `
SELECT p."marketValue", p."grossInvestedCapital", p."moic",
       p."holding", p."liquidity",
       p."grossRealizedValue", p."netRealizedValue",
       p."liquidMarketValue", p."realizedGainLoss",
       a.name   AS "assetName",
       a.ticker,
       a.type   AS "rawAssetType",
       a.id     AS "assetId",
       f.name   AS "fundName"
FROM "PerformanceLatest" p
LEFT JOIN "Asset" a ON p."assetId" = a.id
LEFT JOIN "Fund" f  ON p."fundId"  = f.id
WHERE p."marketValue" > 0
ORDER BY p."marketValue" DESC NULLS LAST
LIMIT 500
`.trim();

// Uses the (priceSourceId, timestamp) composite index via LATERAL — fast even on 6M+ rows
const PRICES_SQL = `
SELECT ps."assetId", lp.price
FROM "PriceSource" ps
JOIN LATERAL (
  SELECT cp.price
  FROM "CoingeckoPrice" cp
  WHERE cp."priceSourceId" = ps.id
  ORDER BY cp.timestamp DESC
  LIMIT 1
) lp ON true
`.trim();

// ── Fund short names ──

const FUND_SHORT: Record<string, string> = {
  "Paradigm Fund LP": "PF",
  "Paradigm One LP": "P1",
  "Paradigm Two LP": "P2",
  "Paradigm Three LP": "P3",
  "Paradigm Green Fortitudo LP": "PGF",
};

// ── Asset type categorization ──

function categorizeAssetType(raw: string | null): string {
  if (!raw) return "Other";
  switch (raw) {
    case "TOKEN": return "Token";
    case "PUBLIC_EQUITY": return "Public";
    case "PRIVATE_EQUITY":
    case "SAFT":
    case "SAFE":
    case "LLC_UNITS":
    case "PARTNERSHIP_INTEREST":
    case "TOKEN_WARRANT": return "Private";
    default: return "Other";
  }
}

// ── Helpers ──

function parseResult(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { /* TOON fallback */ }
  try { const d = decode(raw, { strict: false }); if (d !== undefined) return d; } catch { /* ignore */ }
  return raw;
}

async function dbQuery(sql: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
  const res = await resilientFetch(`${API_URL}/tools/paradigmdb/db_query`, {
    method: "POST",
    body: JSON.stringify({ query: sql }),
    signal,
    timeoutMs: 15_000,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(`DB query error (${res.status}): ${text.slice(0, 300)}`, res.status, res.status >= 500);
  }
  const data = await res.json();
  const parsed = parseResult(data.result ?? data);
  return Array.isArray(parsed) ? parsed as Record<string, unknown>[] : [];
}

// ── Route handler ──

const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60",
};

export async function GET(request: Request) {
  try {
    // Return cached data if fresh
    if (cache && Date.now() - cache.ts < CACHE_TTL) {
      return Response.json({ result: cache.data }, { headers: CACHE_HEADERS });
    }

    // Fetch positions and prices in parallel
    const [positions, prices] = await Promise.all([
      dbQuery(POSITIONS_SQL, request.signal),
      dbQuery(PRICES_SQL, request.signal),
    ]);

    // Build price lookup: assetId -> price
    const priceMap = new Map<string, number>();
    for (const row of prices) {
      const id = row.assetId as string;
      const price = row.price as number;
      if (id && price != null) priceMap.set(id, price);
    }

    // Enrich positions
    const enriched = positions.map((row) => {
      const assetId = row.assetId as string;
      const fundName = (row.fundName as string) || "";
      return {
        assetName: row.assetName as string,
        ticker: row.ticker as string | null,
        fundName,
        fundShort: FUND_SHORT[fundName] || fundName.slice(0, 4),
        assetType: categorizeAssetType(row.rawAssetType as string | null),
        marketValue: row.marketValue as number,
        grossInvestedCapital: row.grossInvestedCapital as number,
        moic: row.moic as number,
        holding: row.holding as number,
        liquidity: row.liquidity as number,
        realizedGainLoss: row.realizedGainLoss as number,
        latestPrice: priceMap.get(assetId) ?? null,
      };
    });

    // Update cache
    cache = { data: enriched, ts: Date.now() };

    return Response.json({ result: enriched }, { headers: CACHE_HEADERS });
  } catch (err) {
    const status = err instanceof ApiError ? (err.status ?? 502) : 502;
    return Response.json(
      { error: err instanceof Error ? err.message : "API unreachable" },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
