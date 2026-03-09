import type { ThreadTokenUsage } from "@/lib/types";

export function formatTokenUsageCount(value: number | null): string {
  return value === null || value === undefined ? "--" : value.toLocaleString();
}

export function formatTokenUsageCost(tokenUsage: ThreadTokenUsage | null): string | null {
  if (!tokenUsage || tokenUsage.cost_usd === null || tokenUsage.cost_usd === undefined) {
    return null;
  }
  return `$${tokenUsage.cost_usd.toFixed(4)}`;
}

export function formatTokenUsageTicker(tokenUsage: ThreadTokenUsage | null): string | null {
  if (!tokenUsage || tokenUsage.total_tokens <= 0) return null;
  const tokenLabel = `${tokenUsage.quality === "estimated" ? "~" : ""}${tokenUsage.total_tokens.toLocaleString()} tok`;
  const costLabel = formatTokenUsageCost(tokenUsage);
  return costLabel ? `${tokenLabel} / ${costLabel}` : tokenLabel;
}

export function tokenUsageConfidenceLabel(tokenUsage: ThreadTokenUsage | null): string {
  if (!tokenUsage) return "--";
  return tokenUsage.quality;
}

export function tokenUsageModelLabel(tokenUsage: ThreadTokenUsage | null): string | null {
  if (!tokenUsage || tokenUsage.models.length === 0) return null;
  if (tokenUsage.models.length === 1) return tokenUsage.models[0] ?? null;
  return "Multiple";
}

export function tokenUsageModelsList(tokenUsage: ThreadTokenUsage | null): string {
  if (!tokenUsage || tokenUsage.models.length === 0) return "--";
  return tokenUsage.models.join(", ");
}

export function tokenUsageBreakdownLabel(tokenUsage: ThreadTokenUsage | null): string {
  if (!tokenUsage) return "--";
  return tokenUsage.breakdown === "known" ? "known" : "unavailable";
}
