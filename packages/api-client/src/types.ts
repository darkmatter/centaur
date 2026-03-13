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

export type FetchOptions = {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxAttempts?: number;
  stream?: boolean;
};
