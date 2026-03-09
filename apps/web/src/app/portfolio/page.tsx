import { resilientFetch, API_URL, ApiError } from "@/lib/bot/api-client";
import { decode } from "@toon-format/toon";
import { PortfolioClient } from "./portfolio-client";
import type { Position } from "./types";

// ── Server-side data fetching (no loading spinner) ──

function parseResult(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { /* */ }
  try { const d = decode(raw, { strict: false }); if (d !== undefined) return d; } catch { /* */ }
  return raw;
}

async function dbQuery(sql: string): Promise<Record<string, unknown>[]> {
  const res = await resilientFetch(`${API_URL}/tools/paradigmdb/db_query`, {
    method: "POST",
    body: JSON.stringify({ query: sql }),
    timeoutMs: 15_000,
  });
  if (!res.ok) return [];
  const data = await res.json();
  const parsed = parseResult(data.result);
  return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
}

const POSITIONS_SQL = `SELECT p."marketValue", p."grossInvestedCapital", p."moic",
  p."holding", p."liquidity", p."realizedGainLoss",
  p."grossRealizedValue", p."dividendValue",
  a.name AS "assetName", a.ticker, a.type AS "rawAssetType", a.id AS "assetId",
  a."organizationId",
  f.name AS "fundName",
  o.name AS "organizationName"
  FROM "PerformanceLatest" p
  LEFT JOIN "Asset" a ON p."assetId" = a.id
  LEFT JOIN "Fund" f  ON p."fundId"  = f.id
  LEFT JOIN "Organization" o ON a."organizationId" = o.id
  WHERE p."marketValue" >= 1
  ORDER BY p."marketValue" DESC NULLS LAST LIMIT 500`;

const PRICES_SQL = `SELECT ps."assetId", lp.price
  FROM "PriceSource" ps
  JOIN LATERAL (
    SELECT cp.price FROM "CoingeckoPrice" cp
    WHERE cp."priceSourceId" = ps.id
    ORDER BY cp.timestamp DESC LIMIT 1
  ) lp ON true`;

async function fetchPositions(): Promise<Position[]> {
  try {
    // Parallel fetch: positions (~0.5s) + prices (~0.2s)
    const [rows, priceRows] = await Promise.all([
      dbQuery(POSITIONS_SQL),
      dbQuery(PRICES_SQL).catch(() => [] as Record<string, unknown>[]),
    ]);
    if (rows.length === 0) return [];

    const priceMap = new Map<string, number>();
    for (const r of priceRows) {
      if (r.assetId && r.price != null) priceMap.set(r.assetId as string, r.price as number);
    }

    const FUND_SHORT: Record<string, string> = {
      "Paradigm Fund LP": "PF",
      "Paradigm One LP": "P1",
      "Paradigm Two LP": "P2",
      "Paradigm Three LP": "P3",
      "Paradigm Green Fortitudo LP": "PGF",
    };

    return rows.map((r) => {
      const fundName = (r.fundName as string) || "";
      const rawType = (r.rawAssetType as string) || "";
      let assetType = "Other";
      if (rawType === "TOKEN") assetType = "Token";
      else if (rawType === "PUBLIC_EQUITY") assetType = "Public";
      else if (["PRIVATE_EQUITY", "SAFT", "SAFE", "LLC_UNITS", "PARTNERSHIP_INTEREST", "TOKEN_WARRANT"].includes(rawType))
        assetType = "Private";

      const mv = (r.marketValue as number) || 0;
      const gic = (r.grossInvestedCapital as number) || 0;

      return {
        assetName: (r.assetName as string) || "Unknown",
        ticker: (r.ticker as string) || null,
        fundName,
        fundShort: FUND_SHORT[fundName] || fundName.slice(0, 4),
        assetType,
        organizationId: (r.organizationId as string) || null,
        organizationName: (r.organizationName as string) || null,
        marketValue: mv,
        grossInvestedCapital: gic,
        grossRealizedValue: (r.grossRealizedValue as number) || 0,
        dividendValue: (r.dividendValue as number) || 0,
        moic: (r.moic as number) || 0,
        holding: (r.holding as number) || 0,
        realizedGainLoss: (r.realizedGainLoss as number) || 0,
        unrealizedGainLoss: mv - gic,
        latestPrice: priceMap.get(r.assetId as string) ?? null,
      };
    });
  } catch {
    return [];
  }
}

export const dynamic = "force-dynamic";

export default async function PortfolioPage() {
  const positions = await fetchPositions();
  return <PortfolioClient initialPositions={positions} />;
}
