/** GET /api/threads — list threads from Postgres (10s cache) */

import { getPool } from "@/lib/db";

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
        MAX(created_at) AS last_activity,
        COUNT(*)::int AS message_count,
        (SELECT parts FROM chat_messages cm2
         WHERE cm2.thread_key = cm.thread_key AND cm2.role = 'user'
         ORDER BY cm2.created_at ASC LIMIT 1) AS first_user_parts,
        (SELECT parts FROM chat_messages cm3
         WHERE cm3.thread_key = cm.thread_key AND cm3.role = 'user'
         ORDER BY cm3.created_at DESC LIMIT 1) AS last_user_parts,
        (SELECT metadata->>'thread_name' FROM chat_messages cm4
         WHERE cm4.thread_key = cm.thread_key AND cm4.metadata->>'thread_name' IS NOT NULL
         ORDER BY cm4.created_at DESC LIMIT 1) AS thread_name
      FROM chat_messages cm
      GROUP BY thread_key
      ORDER BY MAX(created_at) DESC
      LIMIT 200
    `);

    const threads = rows.map((row) => ({
      slack_thread_key: row.thread_key,
      harness: "amp",
      state: "idle",
      created_at: new Date(row.created_at).getTime() / 1000,
      last_activity: new Date(row.last_activity).getTime() / 1000,
      turn_count: row.message_count,
      first_message: extractText(row.first_user_parts),
      last_user_message: extractText(row.last_user_parts),
      thread_name: row.thread_name,
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
