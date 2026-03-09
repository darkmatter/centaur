import type { SubagentActivity, SubagentStep } from "@/lib/describe";

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? value : undefined;
}

function pickString(next: string | undefined, prev: string | undefined): string | undefined {
  return nonEmpty(next) ?? nonEmpty(prev);
}

function pickNumber(next: number | undefined, prev: number | undefined): number | undefined {
  return typeof next === "number" ? next : prev;
}

function pickMaxNumber(next: number | null | undefined, prev: number | null | undefined): number | null | undefined {
  if (typeof next === "number" && typeof prev === "number") return Math.max(next, prev);
  if (typeof next === "number") return next;
  if (typeof prev === "number") return prev;
  if (next === null) return prev ?? null;
  return prev;
}

export function normalizeSubagentStatus(status: string | undefined): string {
  const normalized = (status ?? "").trim().toLowerCase();
  if (normalized === "progress") return "working";
  return normalized;
}

export function subagentStatusLabel(status: string | undefined): string {
  switch (normalizeSubagentStatus(status)) {
    case "working":
      return "Running";
    case "started":
      return "Starting";
    case "completed":
      return "Complete";
    case "failed":
      return "Failed";
    case "selected":
      return "Selected";
    default:
      return normalizeSubagentStatus(status).replace(/_/g, " ") || "Update";
  }
}

function statusRank(status: string | undefined): number {
  switch (normalizeSubagentStatus(status)) {
    case "failed":
      return 4;
    case "completed":
    case "selected":
      return 3;
    case "working":
      return 2;
    case "started":
      return 1;
    default:
      return 0;
  }
}

function activityFingerprint(activity: SubagentActivity): string {
  return `${activity.toolName ?? ""}::${activity.description.trim()}`;
}

export function buildSubagentStepId(
  turnId: number | undefined,
  subagentId: string | undefined,
  fallbackId: string,
): string {
  if (!subagentId && fallbackId.startsWith("subagent:")) {
    return fallbackId;
  }
  const turnKey = typeof turnId === "number" ? String(turnId) : "thread";
  const subagentKey = (subagentId || fallbackId || "unknown").trim();
  return `subagent:${turnKey}:${subagentKey}`;
}

export function subagentSelectionKey(step: Pick<SubagentStep, "id" | "turnId" | "subagentId">): string {
  if (!step.subagentId && step.id.startsWith("subagent:")) {
    return step.id;
  }
  return buildSubagentStepId(step.turnId, step.subagentId, step.id);
}

export function mergeSubagentActivities(
  existing: SubagentActivity[] | undefined,
  incoming: SubagentActivity[] | undefined,
): SubagentActivity[] | undefined {
  const merged = [...(existing ?? []), ...(incoming ?? [])];
  if (merged.length === 0) return undefined;
  const seen = new Set<string>();
  const deduped: SubagentActivity[] = [];
  for (const activity of merged) {
    const description = activity.description.trim();
    if (!description) continue;
    const fingerprint = activityFingerprint(activity);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    deduped.push({
      description: activity.description,
      toolName: nonEmpty(activity.toolName),
    });
  }
  return deduped.length > 0 ? deduped : undefined;
}

export function mergeSubagentStep(existing: SubagentStep | undefined, incoming: SubagentStep): SubagentStep {
  if (!existing) return incoming;

  const existingStatus = normalizeSubagentStatus(existing.status);
  const incomingStatus = normalizeSubagentStatus(incoming.status);
  const mergedStatus =
    statusRank(incomingStatus) >= statusRank(existingStatus) ? incomingStatus : existingStatus;

  return {
    ...existing,
    ...incoming,
    id: buildSubagentStepId(
      incoming.turnId ?? existing.turnId,
      incoming.subagentId ?? existing.subagentId,
      incoming.id || existing.id,
    ),
    turnId: incoming.turnId ?? existing.turnId,
    subagentId: pickString(incoming.subagentId, existing.subagentId),
    status: mergedStatus,
    name: pickString(incoming.name, existing.name),
    phase: pickString(incoming.phase, existing.phase),
    summary: pickString(incoming.summary, existing.summary),
    error: pickString(incoming.error, existing.error),
    activity: pickString(incoming.activity, existing.activity),
    activities: mergeSubagentActivities(existing.activities, incoming.activities),
    branchIndex: pickNumber(incoming.branchIndex, existing.branchIndex),
    totalBranches: pickNumber(incoming.totalBranches, existing.totalBranches),
    completed: pickMaxNumber(incoming.completed, existing.completed) ?? undefined,
    acceptable: pickMaxNumber(incoming.acceptable, existing.acceptable) ?? undefined,
    completedCount: pickMaxNumber(incoming.completedCount, existing.completedCount) ?? undefined,
    acceptableCount: pickMaxNumber(incoming.acceptableCount, existing.acceptableCount) ?? undefined,
    failedCount: pickMaxNumber(incoming.failedCount, existing.failedCount) ?? undefined,
    failed: pickMaxNumber(incoming.failed, existing.failed) ?? undefined,
    isAcceptable: incoming.isAcceptable ?? existing.isAcceptable,
    turns: pickMaxNumber(incoming.turns, existing.turns) ?? undefined,
    toolCalls: pickMaxNumber(incoming.toolCalls, existing.toolCalls) ?? undefined,
    durationS: pickMaxNumber(incoming.durationS, existing.durationS) ?? undefined,
    maxParallel: pickMaxNumber(incoming.maxParallel, existing.maxParallel) ?? undefined,
    inputTokens: pickMaxNumber(incoming.inputTokens, existing.inputTokens) ?? undefined,
    outputTokens: pickMaxNumber(incoming.outputTokens, existing.outputTokens) ?? undefined,
    totalTokens: pickMaxNumber(incoming.totalTokens, existing.totalTokens) ?? undefined,
    costUsd: pickMaxNumber(incoming.costUsd, existing.costUsd) ?? null,
    model: pickString(incoming.model, existing.model),
    eventSeq: pickMaxNumber(incoming.eventSeq, existing.eventSeq) ?? undefined,
  };
}

export function getSubagentPreviewText(step: Pick<SubagentStep, "status" | "summary" | "error" | "activity">): string | undefined {
  const status = normalizeSubagentStatus(step.status);
  if (status === "failed") return nonEmpty(step.error) ?? nonEmpty(step.summary) ?? nonEmpty(step.activity);
  if (status === "completed" || status === "selected") {
    return nonEmpty(step.summary) ?? nonEmpty(step.error) ?? nonEmpty(step.activity);
  }
  return nonEmpty(step.activity) ?? nonEmpty(step.summary);
}

export function isSubagentTerminal(status: string | undefined): boolean {
  const normalized = normalizeSubagentStatus(status);
  return normalized === "completed" || normalized === "selected" || normalized === "failed";
}
