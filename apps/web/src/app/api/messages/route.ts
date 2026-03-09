/**
 * GET /api/messages?key={thread_key}&limit=N&before={id}
 *
 * Returns the newest N messages (default: all). When `limit` is set the
 * response includes a `has_more` flag so the client can paginate upward.
 * Pass `before={message_id}` to fetch the next page of older messages.
 *
 * Response shape:
 *   { messages: UIMessage[], has_more: boolean }
 *
 * When neither `limit` nor `before` is provided, all messages are returned
 * (backwards-compatible flat array).
 */

import { NextRequest } from "next/server";
import { safeValidateUIMessages } from "ai";
import { dataPartSchemas } from "@/lib/data-part-schemas";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const messagesCache = new Map<string, { data: unknown; ts: number }>();
const MESSAGES_TTL = 3_000;

export async function GET(request: NextRequest) {
  const threadKey = request.nextUrl.searchParams.get("key");
  if (!threadKey) {
    return Response.json({ error: "Missing key parameter" }, { status: 400 });
  }

  const limitParam = request.nextUrl.searchParams.get("limit");
  const beforeId = request.nextUrl.searchParams.get("before");
  const limit = limitParam ? Math.max(1, Math.min(200, parseInt(limitParam, 10) || 200)) : null;
  const paginated = limit !== null;

  try {
    const pool = getPool();
    let rows: Array<Record<string, unknown>>;

    if (paginated && beforeId) {
      // Fetch `limit` messages older than the cursor, newest-first within the page
      const result = await pool.query(
        `SELECT id, role, parts, created_at, metadata
         FROM chat_messages
         WHERE thread_key = $1
           AND created_at < (SELECT created_at FROM chat_messages WHERE id = $2)
         ORDER BY created_at DESC
         LIMIT $3`,
        [threadKey, beforeId, limit + 1],
      );
      rows = result.rows;
    } else if (paginated) {
      // Fetch the newest `limit` messages (tail)
      const result = await pool.query(
        `SELECT id, role, parts, created_at, metadata
         FROM chat_messages
         WHERE thread_key = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [threadKey, limit + 1],
      );
      rows = result.rows;
    } else {
      // No pagination — return everything (backwards-compatible)
      const cached = messagesCache.get(threadKey);
      if (cached && Date.now() - cached.ts < MESSAGES_TTL) {
        return Response.json(cached.data, {
          headers: { "Cache-Control": "public, s-maxage=5, stale-while-revalidate=3" },
        });
      }
      const result = await pool.query(
        `SELECT id, role, parts, created_at, metadata
         FROM chat_messages
         WHERE thread_key = $1
         ORDER BY created_at`,
        [threadKey],
      );
      rows = result.rows;
    }

    // For paginated queries we fetched limit+1 to detect has_more
    let hasMore = false;
    if (paginated && rows.length > limit) {
      hasMore = true;
      rows = rows.slice(0, limit);
    }

    // Paginated queries are DESC — reverse to chronological order
    if (paginated) {
      rows.reverse();
    }

    const messages = rows.map((row) => ({
      id: row.id as string,
      role: row.role as string,
      parts: row.parts,
      createdAt: row.created_at ? new Date(row.created_at as string).toISOString() : null,
      metadata: row.metadata,
    }));

    const validated = await safeValidateUIMessages({
      messages,
      dataSchemas: dataPartSchemas,
    });

    const validatedMessages = validated.success ? validated.data : messages;

    if (paginated) {
      return Response.json(
        { messages: validatedMessages, has_more: hasMore },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    // Backwards-compatible: flat array
    if (!paginated) {
      messagesCache.set(threadKey, { data: validatedMessages, ts: Date.now() });
    }
    return Response.json(validatedMessages, {
      headers: { "Cache-Control": "public, s-maxage=5, stale-while-revalidate=3" },
    });
  } catch (err) {
    console.error("Failed to fetch messages:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Database error" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
