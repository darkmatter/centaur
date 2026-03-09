/** /api/threads/detail?key=... — thread detail from Postgres + pipe status enrichment */

import { getPool } from "@/lib/db";
import { resilientFetch, API_URL } from "@/lib/bot/api-client";
import type { Harness, ThreadDetail, ThreadState } from "@/lib/types";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const detailCache = new Map<string, { data: ThreadDetail; ts: number }>();
const DETAIL_TTL = 5_000;

type PipeStatus = {
  thread_key: string;
  status: string;
  container_id?: string;
  harness?: string;
  engine?: string;
  started_at?: number;
};

function extractText(parts: unknown): string | null {
  const arr = Array.isArray(parts) ? parts : [];
  for (const p of arr) {
    if (p && typeof p === "object" && typeof p.text === "string") return p.text;
  }
  return null;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get("key") || "";
  if (!key) {
    return Response.json({ error: "Missing thread key" }, { status: 400 });
  }

  try {
    let detail: ThreadDetail;
    const cached = detailCache.get(key);

    if (cached && Date.now() - cached.ts < DETAIL_TTL) {
      detail = { ...cached.data };
    } else {
      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT
          MIN(created_at) AS created_at,
          MAX(created_at) AS last_activity,
          COUNT(*)::int AS message_count,
          (SELECT parts FROM chat_messages cm2
           WHERE cm2.thread_key = $1 AND cm2.role = 'user'
           ORDER BY cm2.created_at DESC LIMIT 1
          ) AS last_user_parts,
          (SELECT metadata->>'thread_name' FROM chat_messages cm3
           WHERE cm3.thread_key = $1 AND cm3.metadata->>'thread_name' IS NOT NULL
           ORDER BY cm3.created_at DESC LIMIT 1
          ) AS thread_name
        FROM chat_messages
        WHERE thread_key = $1`,
        [key],
      );

      const row = rows[0];
      if (!row || !row.created_at) {
        return Response.json(
          { error: `Thread not found: ${key}` },
          { status: 404, headers: { "Cache-Control": "no-store" } },
        );
      }

      detail = {
        slack_thread_key: key,
        harness: "amp",
        state: "idle",
        created_at: new Date(row.created_at).getTime() / 1000,
        last_activity: new Date(row.last_activity).getTime() / 1000,
        message_count: row.message_count,
        last_user_message: extractText(row.last_user_parts),
        token_usage: null,
        thread_name: row.thread_name,
      };
      detailCache.set(key, { data: detail, ts: Date.now() });
    }

    // Enrich with live pipe status (best-effort)
    try {
      const pipeRes = await resilientFetch(
        `${API_URL}/agent/status?key=${encodeURIComponent(key)}`,
        { timeoutMs: 3000, signal: request.signal },
      );
      if (pipeRes.ok) {
        const pipeStatus = (await pipeRes.json()) as PipeStatus;
        const isRunning = pipeStatus.status === "running";
        detail.state = (isRunning ? "running" : "idle") as ThreadState;
        detail.harness = (pipeStatus.harness as Harness) ?? detail.harness;
      }
    } catch {
      // Pipe server unreachable — keep idle state
    }

    return Response.json(detail, {
      headers: { "Cache-Control": "public, s-maxage=5, stale-while-revalidate=3" },
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Database error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
