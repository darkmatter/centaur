import { DefaultChatTransport } from "ai";
import type { ChatRequestOptions, UIMessage, UIMessageChunk } from "ai";
import { BASE } from "@/lib/constants";

/**
 * Custom ChatTransport for agent threads.
 *
 * Extends the AI SDK's DefaultChatTransport which handles:
 * - SSE parsing (EventSourceParserStream)
 * - UIMessageChunk deserialization + schema validation
 * - Stream processing via parseJsonEventStream
 *
 * We only customize the request shape: the pipe server expects
 * { slack_thread_key, message, harness } rather than the standard
 * useChat body format.
 */
export class AgentThreadTransport<
  UI_MESSAGE extends UIMessage = UIMessage,
> extends DefaultChatTransport<UI_MESSAGE> {
  private readonly threadKey: string;

  constructor(threadKey: string) {
    super({
      api: `${BASE}/api/agent/execute`,
      prepareSendMessagesRequest: async ({ messages, body }) => {
        const lastMessage = messages[messages.length - 1];
        const text = extractMessageText(lastMessage);
        const harness =
          typeof body?.harness === "string" && body.harness.trim().length > 0
            ? body.harness.trim()
            : undefined;

        return {
          body: {
            slack_thread_key: threadKey,
            message: text,
            ...(harness ? { harness } : {}),
            messages,
          },
        };
      },
    });
    this.threadKey = threadKey;
  }

  override async reconnectToStream(
    _options: { chatId: string } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    // The pipe model (stdin/stdout per container) doesn't support
    // reconnecting to an in-progress stream. Return null to let
    // the client fall back to polling via fetchThread.
    return null;
  }
}

function extractMessageText(message: UIMessage | undefined): string {
  if (!message) return "";
  if (typeof (message as { text?: unknown }).text === "string") {
    return ((message as { text?: string }).text ?? "").trim();
  }
  const parts =
    (message as { parts?: Array<{ type?: string; text?: string }> }).parts ??
    [];
  const textParts = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "");
  return textParts.join("\n").trim();
}
