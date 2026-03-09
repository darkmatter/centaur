import {
  execute,
  executeStreaming,
  reconnectStreaming,
  type Engine,
  type FileAttachment,
  type Harness,
} from "../harness";
import type { CanonicalEvent } from "@/lib/normalize-harness-event";

export function isBusyRunError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("already in progress") || normalized.includes("run is already in progress");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeWithBusyRetries(params: {
  threadKey: string;
  message: string;
  harness: Harness;
  requestId: string;
  files?: FileAttachment[];
  userId?: string;
  model?: string | null;
  engine?: Engine | null;
  continueSession?: boolean;
}): Promise<string> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await execute(
        params.threadKey,
        params.message,
        params.harness,
        params.requestId,
        params.files,
        params.userId,
        "slack",
        params.model,
        params.engine,
        params.continueSession ?? true,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const shouldRetry = isBusyRunError(detail) && attempt < maxAttempts;
      if (!shouldRetry) throw error;
      await sleep(Math.min(300 * Math.pow(2, attempt - 1), 2500));
    }
  }
  return "";
}

export async function* executeStreamingWithBusyRetries(params: {
  threadKey: string;
  message: string;
  harness: Harness;
  engine?: Engine | null;
}): AsyncGenerator<CanonicalEvent, string, undefined> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return yield* executeStreaming(
        params.threadKey,
        params.message,
        params.harness,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const shouldRetry = isBusyRunError(detail) && attempt < maxAttempts;
      if (!shouldRetry) throw error;
      await sleep(Math.min(300 * Math.pow(2, attempt - 1), 2500));
    }
  }
  return "";
}

export async function* reconnectStreamingWithRetries(params: {
  threadKey: string;
  harness: Harness;
  skipCount?: number;
}): AsyncGenerator<CanonicalEvent, string, undefined> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return yield* reconnectStreaming(
        params.threadKey,
        params.harness,
        params.skipCount ?? 0,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const shouldRetry = isBusyRunError(detail) && attempt < maxAttempts;
      if (!shouldRetry) throw error;
      await sleep(Math.min(300 * Math.pow(2, attempt - 1), 2500));
    }
  }
  return "";
}
