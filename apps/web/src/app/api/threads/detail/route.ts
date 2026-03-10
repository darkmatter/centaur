/** /api/threads/detail?key=... — thread detail from Postgres + pipe status enrichment */

import { getPool } from "@/lib/db";
import { resilientFetch, API_URL } from "@/lib/api-client";
import type { Harness, ThreadDetail, ThreadState } from "@/lib/types";
import {
  deriveStoredThreadState,
  normalizeThreadHarness,
  normalizeThreadStateValue,
} from "@/lib/viewer/thread-runtime";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

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
    let persistedSessionState: unknown;
    let persistedLatestRole: unknown;
    let persistedLatestParts: unknown;
    let persistedSessionLastActivityMs: number | null = null;
    let persistedMessageLastActivityMs: number | null = null;
    const pool = getPool();
    const { rows } = await pool.query(
        `SELECT
          MIN(created_at) AS created_at,
          MAX(created_at) AS message_last_activity,
          COUNT(*)::int AS message_count,
          (SELECT parts FROM chat_messages cm2
           WHERE cm2.thread_key = $1 AND cm2.role = 'user'
           ORDER BY cm2.created_at DESC LIMIT 1
          ) AS last_user_parts,
          (SELECT role FROM chat_messages cm4
           WHERE cm4.thread_key = $1
           ORDER BY cm4.created_at DESC LIMIT 1
          ) AS latest_role,
          (SELECT parts FROM chat_messages cm5
           WHERE cm5.thread_key = $1
           ORDER BY cm5.created_at DESC LIMIT 1
          ) AS latest_parts,
          (SELECT metadata->>'thread_name' FROM chat_messages cm3
           WHERE cm3.thread_key = $1 AND cm3.metadata->>'thread_name' IS NOT NULL
           ORDER BY cm3.created_at DESC LIMIT 1
          ) AS metadata_thread_name,
          (SELECT metadata->>'harness' FROM chat_messages cm6
           WHERE cm6.thread_key = $1 AND cm6.metadata->>'harness' IS NOT NULL
           ORDER BY cm6.created_at DESC LIMIT 1
          ) AS metadata_harness,
          MAX(s.harness) AS session_harness,
          MAX(s.engine) AS session_engine,
          MAX(s.state) AS session_state,
          MAX(s.thread_name) AS session_thread_name,
          MAX(s.last_activity) AS session_last_activity
        FROM chat_messages
        LEFT JOIN agent_sessions s ON s.slack_thread_key = thread_key
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
      harness: normalizeThreadHarness(
        row.metadata_harness,
        row.session_harness,
        row.session_engine,
      ),
      state: deriveStoredThreadState(
        row.session_state,
        row.latest_role,
        row.latest_parts,
        row.session_last_activity
          ? new Date(row.session_last_activity).getTime()
          : null,
        new Date(row.message_last_activity).getTime(),
      ),
      created_at: new Date(row.created_at).getTime() / 1000,
      last_activity:
        Math.max(
          new Date(row.message_last_activity).getTime(),
          row.session_last_activity
            ? new Date(row.session_last_activity).getTime()
            : 0,
        ) / 1000,
      message_count: row.message_count,
      last_user_message: extractText(row.last_user_parts),
      token_usage: null,
      thread_name: row.metadata_thread_name || row.session_thread_name,
    };
    persistedSessionState = row.session_state;
    persistedLatestRole = row.latest_role;
    persistedLatestParts = row.latest_parts;
    persistedSessionLastActivityMs = row.session_last_activity
      ? new Date(row.session_last_activity).getTime()
      : null;
    persistedMessageLastActivityMs = new Date(row.message_last_activity).getTime();

    // Enrich with live pipe status (best-effort)
    try {
      const pipeRes = await resilientFetch(
        `${API_URL}/agent/status?key=${encodeURIComponent(key)}`,
        { timeoutMs: 3000, signal: request.signal },
      );
      if (pipeRes.ok) {
        const pipeStatus = (await pipeRes.json()) as PipeStatus;
        const liveState = normalizeThreadStateValue(pipeStatus.status);
        if (liveState && liveState !== "idle" && liveState !== "stopped") {
          detail.state = liveState as ThreadState;
        } else if (liveState === "idle" || liveState === "stopped") {
          if (
            persistedSessionState !== undefined ||
            persistedLatestRole !== undefined ||
            persistedLatestParts !== undefined
          ) {
            detail.state = deriveStoredThreadState(
              persistedSessionState,
              persistedLatestRole,
              persistedLatestParts,
              persistedSessionLastActivityMs,
              persistedMessageLastActivityMs,
            );
          }
        }
        detail.harness = normalizeThreadHarness(
          pipeStatus.harness,
          pipeStatus.engine,
          detail.harness,
        );
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
