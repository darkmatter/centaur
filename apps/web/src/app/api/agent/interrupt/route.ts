/** Proxy POST /api/agent/interrupt -> FastAPI /pipe/stop */

import { resilientFetch, API_URL, ApiError } from "@/lib/api-client";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const slackThreadKey = String(body.slack_thread_key ?? "").trim();
  if (!slackThreadKey) {
    return Response.json(
      { error: "Missing slack_thread_key" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const upstream = await resilientFetch(`${API_URL}/agent/stop`, {
      method: "POST",
      body: JSON.stringify({ thread_key: slackThreadKey }),
      timeoutMs: 30_000,
      signal: request.signal,
    });

    const data = await upstream.json();
    return Response.json(data, {
      status: upstream.ok ? 200 : upstream.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const status = err instanceof ApiError ? (err.status ?? 502) : 502;
    return Response.json(
      { error: err instanceof Error ? err.message : "API unreachable" },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
