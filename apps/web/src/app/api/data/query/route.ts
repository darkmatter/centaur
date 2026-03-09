/** Proxy /api/data/query -> POST /tools/paradigmdb/db_query */

import { resilientFetch, API_URL, ApiError } from "@/lib/bot/api-client";
import { decode } from "@toon-format/toon";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/** Parse a tool result string that may be JSON or TOON-encoded. */
function parseResult(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    // Fall back to TOON
  }
  try {
    const decoded = decode(raw, { strict: false });
    if (decoded !== undefined) return decoded;
  } catch {
    // ignore
  }
  return raw;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { query?: string; target?: string };
    if (!body.query || typeof body.query !== "string") {
      return Response.json(
        { error: "Missing required field: query" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const res = await resilientFetch(`${API_URL}/tools/paradigmdb/db_query`, {
      method: "POST",
      body: JSON.stringify({ query: body.query, limit: 500 }),
      signal: request.signal,
      timeoutMs: 30_000,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(
        `db_query error (${res.status}): ${text.slice(0, 300)}`,
        res.status,
        res.status >= 500,
      );
    }

    const data = await res.json();

    // The tool returns { result: "<TOON or JSON string>" } — unwrap and parse
    const parsed = parseResult(data.result ?? data);
    const rows = Array.isArray(parsed) ? parsed : [];

    return Response.json(rows, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const status = err instanceof ApiError ? (err.status ?? 502) : 502;
    return Response.json(
      { error: err instanceof Error ? err.message : "API unreachable" },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
