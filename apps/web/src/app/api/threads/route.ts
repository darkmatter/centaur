/** GET /api/threads — list threads from Postgres (10s cache) */

import { getPool } from "@/lib/db";
import {
  deriveStoredThreadState,
  normalizeThreadHarness,
} from "@/lib/viewer/thread-runtime";

export const dynamic = "force-dynamic";

// In-memory cache (10s TTL — thread list doesn't need real-time)
let cache: { data: unknown; ts: number } | null = null;
const CACHE_TTL = 10_000;

function extractText(parts: unknown): string | null {
  const arr = Array.isArray(parts) ? parts : [];
  for (const p of arr) {
    if (p && typeof p === "object" && typeof p.text === "string") return p.text;
  }
  return null;
}

export async function GET() {
  try {
    if (cache && Date.now() - cache.ts < CACHE_TTL) {
      return Response.json(cache.data, {
        headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=5" },
      });
    }

    const pool = getPool();
    const { rows } = await pool.query(`
      SELECT
        thread_key,
        MIN(created_at) AS created_at,
        MAX(created_at) AS message_last_activity,
        COUNT(*)::int AS message_count,
        (SELECT parts FROM chat_messages cm2
         WHERE cm2.thread_key = cm.thread_key AND cm2.role = 'user'
         ORDER BY cm2.created_at ASC LIMIT 1) AS first_user_parts,
        (SELECT parts FROM chat_messages cm3
         WHERE cm3.thread_key = cm.thread_key AND cm3.role = 'user'
         ORDER BY cm3.created_at DESC LIMIT 1) AS last_user_parts,
        (SELECT metadata->>'thread_name' FROM chat_messages cm4
         WHERE cm4.thread_key = cm.thread_key AND cm4.metadata->>'thread_name' IS NOT NULL
         ORDER BY cm4.created_at DESC LIMIT 1) AS metadata_thread_name,
        (SELECT metadata->>'harness' FROM chat_messages cm5
         WHERE cm5.thread_key = cm.thread_key AND cm5.metadata->>'harness' IS NOT NULL
         ORDER BY cm5.created_at DESC LIMIT 1) AS metadata_harness,
        (SELECT role FROM chat_messages cm6
         WHERE cm6.thread_key = cm.thread_key
         ORDER BY cm6.created_at DESC LIMIT 1) AS latest_role,
        (SELECT parts FROM chat_messages cm7
         WHERE cm7.thread_key = cm.thread_key
         ORDER BY cm7.created_at DESC LIMIT 1) AS latest_parts,
        MAX(s.harness) AS session_harness,
        MAX(s.engine) AS session_engine,
        MAX(s.state) AS session_state,
        MAX(s.thread_name) AS session_thread_name,
        MAX(s.last_activity) AS session_last_activity
      FROM chat_messages cm
      LEFT JOIN agent_sessions s ON s.slack_thread_key = cm.thread_key
      GROUP BY thread_key
      ORDER BY GREATEST(MAX(created_at), COALESCE(MAX(s.last_activity), MAX(created_at))) DESC
      LIMIT 200
    `);

    const threads = rows.map((row) => ({
      slack_thread_key: row.thread_key,
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
      turn_count: row.message_count,
      first_message: extractText(row.first_user_parts),
      last_user_message: extractText(row.last_user_parts),
      thread_name: row.metadata_thread_name || row.session_thread_name,
    }));

    const result = { threads };
    cache = { data: result, ts: Date.now() };

    return Response.json(result, {
      headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=5" },
    });
  } catch (err) {
    console.error("Failed to list threads:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Database error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
