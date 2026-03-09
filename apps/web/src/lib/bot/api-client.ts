const API_URL = process.env.AI_V2_API_URL || "http://api:8000";
const API_KEY = process.env.AI_V2_API_KEY || "";

const RETRY_DEFAULTS = {
  maxAttempts: 4,
  initialDelayMs: 500,
  maxDelayMs: 8_000,
  factor: 2,
};

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly retryable: boolean,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function isNetworkError(err: unknown): boolean {
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
    msg.includes("udn_err")
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

type FetchOptions = {
  method?: string;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxAttempts?: number;
  stream?: boolean;
};

/**
 * Fetch with automatic retry on network errors and 5xx.
 * Streaming requests (SSE) are not retried — they reconnect at a higher level.
 */
export async function resilientFetch(
  url: string,
  opts: FetchOptions = {},
): Promise<Response> {
  const maxAttempts = opts.stream ? 1 : (opts.maxAttempts ?? RETRY_DEFAULTS.maxAttempts);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
  };
  if (opts.body) {
    headers["Content-Type"] = "application/json";
  }

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
        console.log(JSON.stringify({
          event: "api_retry",
          url,
          status: res.status,
          attempt: attempt + 1,
          next_delay_ms: Math.round(wait),
        }));
        await sleep(wait);
        continue;
      }

      return res;
    } catch (err) {
      if (opts.signal?.aborted) throw err;

      if (isNetworkError(err) && attempt + 1 < maxAttempts) {
        lastError = err;
        const wait = delayMs(attempt);
        console.log(JSON.stringify({
          event: "api_retry",
          url,
          error: err instanceof Error ? err.message : String(err),
          attempt: attempt + 1,
          next_delay_ms: Math.round(wait),
        }));
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

/** POST JSON to the API with retry. Returns parsed JSON. */
export async function apiPost(
  path: string,
  payload: Record<string, unknown>,
  opts?: { timeoutMs?: number; maxAttempts?: number; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const t0 = performance.now();
  const url = `${API_URL}${path}`;

  const res = await resilientFetch(url, {
    method: "POST",
    body: JSON.stringify(payload),
    timeoutMs: opts?.timeoutMs,
    maxAttempts: opts?.maxAttempts,
    signal: opts?.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(
      `${path} failed (${res.status}): ${text.slice(0, 300)}`,
      res.status,
      res.status >= 500,
    );
  }

  const data = await res.json();
  const elapsed = Math.round(performance.now() - t0);
  console.log(JSON.stringify({
    event: "api_call",
    path,
    thread: payload.slack_thread_key ?? payload.thread_key ?? null,
    elapsed_ms: elapsed,
  }));

  return data;
}

/** GET from the API with retry. Returns the Response for streaming. */
export async function apiGet(
  path: string,
  params?: Record<string, string>,
  opts?: { signal?: AbortSignal; stream?: boolean; timeoutMs?: number; maxAttempts?: number },
): Promise<Response> {
  const qs = params ? `?${new URLSearchParams(params).toString()}` : "";
  const url = `${API_URL}${path}${qs}`;

  return resilientFetch(url, {
    method: "GET",
    stream: opts?.stream,
    signal: opts?.signal,
    timeoutMs: opts?.timeoutMs,
    maxAttempts: opts?.maxAttempts,
  });
}

/** Quick health probe. Returns true if API is reachable. */
export async function isApiHealthy(): Promise<boolean> {
  try {
    const res = await resilientFetch(`${API_URL}/health`, {
      timeoutMs: 3_000,
      maxAttempts: 1,
    });
    return res.ok;
  } catch {
    return false;
  }
}

export { API_URL, API_KEY };
