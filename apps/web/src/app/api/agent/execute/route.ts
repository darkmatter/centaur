/**
 * POST /api/agent/execute
 *
 * Accepts { slack_thread_key, message, harness? } from the client.
 * Calls the Python pipe server, reads raw harness SSE events, converts them
 * to AI SDK v6 UIMessageChunk objects server-side, and returns a proper
 * AI SDK UIMessage stream response.
 *
 * The client can consume this with DefaultChatTransport / HttpChatTransport
 * — no custom SSE parsing needed on the client side.
 */

import { z } from "zod";
import {
  createUIMessageStreamResponse,
  createUIMessageStream,
  createIdGenerator,
  parseJsonEventStream,
} from "ai";
import type { UIMessage } from "ai";
import { resilientFetch, API_URL, ApiError } from "@/lib/api-client";
import {
  canonicalEventToStreamChunks,
  createConversionState,
} from "@/lib/harness-to-ui-chunks";
import { normalizeHarnessEvent } from "@/lib/normalize-harness-event";
import { getPool } from "@/lib/db";

const generateMessageId = createIdGenerator({ prefix: "msg", size: 16 });

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 300;

const rawEventSchema = z.record(z.string(), z.unknown());

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const slackThreadKey = String(body.slack_thread_key ?? "").trim();
  const message = String(body.message ?? "").trim();
  const harness =
    typeof body.harness === "string" && body.harness.trim().length > 0
      ? body.harness.trim()
      : "amp";
  const originalMessages: UIMessage[] = Array.isArray(body.messages) ? body.messages : [];

  if (!slackThreadKey || !message) {
    return Response.json(
      { error: "Missing slack_thread_key or message" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  let upstream: Response;
  try {
    upstream = await resilientFetch(`${API_URL}/agent/execute`, {
      method: "POST",
      body: JSON.stringify({
        thread_key: slackThreadKey,
        message,
        harness,
      }),
      stream: true,
    });
  } catch (err) {
    const status = err instanceof ApiError ? (err.status ?? 502) : 502;
    return Response.json(
      { error: err instanceof Error ? err.message : "API unreachable" },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return Response.json(
      { error: `Execute failed: ${upstream.status}`, detail: text.slice(0, 500) },
      { status: upstream.status, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!upstream.body) {
    return Response.json(
      { error: "No response body from pipe server" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Parse the raw SSE from the pipe server using the AI SDK's built-in parser
  const rawEvents = parseJsonEventStream({
    stream: upstream.body,
    schema: rawEventSchema,
  });

  // Convert raw harness events → AI SDK UIMessageChunks
  let eventIndex = 0;
  const conversionState = createConversionState();

  const uiChunkStream = rawEvents.pipeThrough(
    new TransformStream({
      transform(parseResult, controller) {
        if (!parseResult.success) {
          // Skip malformed events — keep stream alive
          return;
        }
        const rawEvent = parseResult.value;
        const canonicalEvents = normalizeHarnessEvent(harness, rawEvent);
        const chunks = canonicalEvents.flatMap((event, offset) =>
          canonicalEventToStreamChunks(
            0,
            eventIndex + offset,
            event,
            conversionState,
          ),
        );
        eventIndex += Math.max(1, canonicalEvents.length);
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
      },
    }),
  );

  // Return a proper AI SDK UIMessage stream response
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      originalMessages,
      generateId: generateMessageId,
      execute: async ({ writer }) => {
        writer.merge(uiChunkStream);
      },
      onFinish: async ({ messages }) => {
        try {
          const pool = getPool();
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            // Use explicit created_at with 1ms offsets so messages sort in
            // the order they were streamed (DEFAULT NOW() gives identical
            // timestamps within a transaction).
            const baseTs = Date.now();
            for (let i = 0; i < messages.length; i++) {
              const msg = messages[i];
              const ts = new Date(baseTs + i).toISOString();
              const metadata = {
                harness,
                ...(msg.metadata || {}),
              };
              await client.query(
                `INSERT INTO chat_messages (id, thread_key, role, parts, metadata, created_at)
                 VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::timestamptz)
                 ON CONFLICT (id) DO UPDATE SET parts = $4::jsonb, metadata = $5::jsonb`,
                [
                  msg.id,
                  slackThreadKey,
                  msg.role,
                  JSON.stringify(msg.parts),
                  JSON.stringify(metadata),
                  ts,
                ],
              );
            }
            await client.query("COMMIT");
          } catch (e) {
            await client.query("ROLLBACK");
            throw e;
          } finally {
            client.release();
          }
        } catch {
          // Best-effort persistence — don't block stream
        }
      },
    }),
  });
}
