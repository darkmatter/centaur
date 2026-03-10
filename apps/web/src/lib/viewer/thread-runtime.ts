import type { Harness, ThreadState } from "@/lib/types";

const SUPPORTED_HARNESSES = new Set<Harness>([
  "amp",
  "claude-code",
  "codex",
  "pi-mono",
  "eng",
  "engineer",
  "legal",
]);

const SUPPORTED_THREAD_STATES = new Set<ThreadState>([
  "running",
  "working",
  "stopping",
  "stopped",
  "idle",
  "error",
]);
function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function partLooksErrored(part: Record<string, unknown>): boolean {
  const type = normalizeText(part.type);
  if (type === "error") return true;
  if (normalizeText(part.state).includes("error")) return true;
  if (typeof part.errorText === "string" && part.errorText.trim()) return true;
  return false;
}

function latestPartsContainError(parts: unknown): boolean {
  if (!Array.isArray(parts)) return false;
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (partLooksErrored(part as Record<string, unknown>)) return true;
  }
  return false;
}

function latestPartsContainSuccessSignal(parts: unknown): boolean {
  if (!Array.isArray(parts)) return false;
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    const type = normalizeText(record.type);
    if (type === "text") return true;
    if (type === "data-shell-command" || type === "data-file-changes") return true;
    if (type.startsWith("tool-") && normalizeText(record.state) !== "output-error") {
      return true;
    }
  }
  return false;
}

export function normalizeThreadHarness(
  primaryHarness: unknown,
  secondaryHarness?: unknown,
  engine?: unknown,
): Harness {
  const candidates = [primaryHarness, secondaryHarness, engine];
  for (const value of candidates) {
    const normalized = normalizeText(value);
    if (!normalized) continue;
    if (normalized === "eng" || normalized === "engineer") return normalized as Harness;
    if (SUPPORTED_HARNESSES.has(normalized as Harness)) return normalized as Harness;
  }
  return "amp";
}

export function normalizeThreadStateValue(value: unknown): ThreadState | null {
  const normalized = normalizeText(value);
  return SUPPORTED_THREAD_STATES.has(normalized as ThreadState)
    ? (normalized as ThreadState)
    : null;
}

export function deriveStoredThreadState(
  sessionState: unknown,
  latestRole: unknown,
  latestParts: unknown,
  sessionLastActivityMs?: number | null,
  messageLastActivityMs?: number | null,
): ThreadState {
  const normalizedSessionState = normalizeThreadStateValue(sessionState);
  if (
    normalizedSessionState &&
    typeof sessionLastActivityMs === "number" &&
    Number.isFinite(sessionLastActivityMs) &&
    typeof messageLastActivityMs === "number" &&
    Number.isFinite(messageLastActivityMs) &&
    sessionLastActivityMs >= messageLastActivityMs
  ) {
    return normalizedSessionState;
  }
  const latestRoleNormalized = normalizeText(latestRole);
  if (
    latestRoleNormalized === "assistant" &&
    latestPartsContainError(latestParts) &&
    !latestPartsContainSuccessSignal(latestParts)
  ) {
    return "error";
  }
  if (latestRoleNormalized === "assistant") return "stopped";
  return "idle";
}
