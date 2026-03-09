export interface Position {
  assetName: string;
  ticker: string | null;
  fundName: string;
  fundShort: string;
  assetType: string; // "Token" | "Public" | "Private" | "Other"
  organizationId: string | null;
  organizationName: string | null;
  marketValue: number;
  grossInvestedCapital: number;
  grossRealizedValue: number;
  dividendValue: number;
  moic: number;
  holding: number;
  realizedGainLoss: number;
  unrealizedGainLoss: number;
  latestPrice: number | null;
}

/** Aggregated position: same organization across funds/assets, with per-asset sub-rows. */
export interface AggregatedPosition {
  organizationName: string;
  ticker: string | null;
  assetType: string;
  marketValue: number;
  grossInvestedCapital: number;
  grossRealizedValue: number;
  dividendValue: number;
  moic: number;
  unrealizedGainLoss: number;
  realizedGainLoss: number;
  latestPrice: number | null;
  funds: Position[]; // per-fund/asset breakdown
}
