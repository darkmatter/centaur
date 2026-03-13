import { ApiError, type FetchOptions } from "./types";

const RETRY_DEFAULTS = {
  maxAttempts: 4,
  initialDelayMs: 500,
  maxDelayMs: 8_000,
  factor: 2,
};

export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("epipe") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    msg.includes("dns") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound") ||
    msg.includes("udn_err") ||
    msg.includes("terminated")
  );
}

function delayMs(attempt: number): number {
  const base = Math.min(
    RETRY_DEFAULTS.initialDelayMs * Math.pow(RETRY_DEFAULTS.factor, attempt),
    RETRY_DEFAULTS.maxDelayMs,
  );
  return base * (0.5 + Math.random() * 0.5);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch with automatic retry on network errors and 5xx.
 * Streaming requests (SSE) are not retried — they reconnect at a higher level.
 *
 * @param apiKey - Bearer token injected by the caller (each service reads its own env var).
 * @param log    - Optional structured logger; falls back to console.log JSON.
 */
export async function resilientFetch(
  url: string,
  opts: FetchOptions = {},
  apiKey: string = "",
  log?: { warn: (event: string, meta: Record<string, unknown>) => void },
): Promise<Response> {
  const maxAttempts = opts.stream ? 1 : (opts.maxAttempts ?? RETRY_DEFAULTS.maxAttempts);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    ...opts.headers,
  };
  if (opts.body) {
    headers["Content-Type"] = "application/json";
  }

  const emitWarn = (event: string, meta: Record<string, unknown>) => {
    if (log) {
      log.warn(event, meta);
    } else {
      console.log(JSON.stringify({ event, ...meta }));
    }
  };

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (opts.timeoutMs) {
      timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    }

    const linked = opts.signal;
    const onParentAbort = () => controller.abort();
    linked?.addEventListener("abort", onParentAbort, { once: true });

    try {
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        headers,
        ...(opts.body ? { body: opts.body } : {}),
        signal: controller.signal,
        cache: "no-store" as RequestCache,
      });

      if (res.status >= 500 && attempt + 1 < maxAttempts) {
        const text = await res.text().catch(() => "");
        lastError = new ApiError(
          `${res.status}: ${text.slice(0, 200)}`,
          res.status,
          true,
        );
        const wait = delayMs(attempt);
        emitWarn("api_retry", {
          url,
          status: res.status,
          attempt: attempt + 1,
          next_delay_ms: Math.round(wait),
        });
        await sleep(wait);
        continue;
      }

      return res;
    } catch (err) {
      if (opts.signal?.aborted) throw err;

      if (isNetworkError(err) && attempt + 1 < maxAttempts) {
        lastError = err;
        const wait = delayMs(attempt);
        emitWarn("api_retry", {
          url,
          error: err instanceof Error ? err.message : String(err),
          attempt: attempt + 1,
          next_delay_ms: Math.round(wait),
        });
        await sleep(wait);
        continue;
      }

      throw new ApiError(
        err instanceof Error ? err.message : "fetch failed",
        null,
        isNetworkError(err),
        err,
      );
    } finally {
      if (timer) clearTimeout(timer);
      linked?.removeEventListener("abort", onParentAbort);
    }
  }

  throw lastError instanceof ApiError
    ? lastError
    : new ApiError("Max retries exceeded", null, false, lastError);
}
