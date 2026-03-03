import type { ChatRequestOptions, ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { BASE } from "@/lib/constants";

function extractMessageText(message: UIMessage): string {
  if (typeof (message as { text?: unknown }).text === "string") {
    return ((message as { text?: string }).text ?? "").trim();
  }
  const parts = (message as { parts?: Array<{ type?: string; text?: string }> }).parts ?? [];
  const textParts = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "");
  return textParts.join("\n").trim();
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; detail?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error;
    if (typeof parsed.detail === "string" && parsed.detail.trim()) return parsed.detail;
  } catch {
    // Fall through to raw preview.
  }
  const preview = text.length > 240 ? `${text.slice(0, 240)}...` : text;
  return `${fallback}: ${preview}`;
}

async function openUiStream(
  threadKey: string,
  abortSignal: AbortSignal | undefined,
): Promise<ReadableStream<UIMessageChunk>> {
  const response = await fetch(`${BASE}/api/threads/stream-ui?key=${encodeURIComponent(threadKey)}`, {
    headers: { Accept: "text/event-stream" },
    signal: abortSignal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`stream-ui failed (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const dataLines = rawEvent
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim());
          if (dataLines.length === 0) {
            continue;
          }
          const payload = dataLines.join("\n");
          if (payload === "[DONE]") {
            controller.close();
            return;
          }
          try {
            controller.enqueue(JSON.parse(payload) as UIMessageChunk);
          } catch {
            // Ignore malformed chunks to keep the stream alive.
          }
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      }
    },
    cancel() {
      void reader.cancel();
    },
  });
}

export class AgentThreadTransport<UI_MESSAGE extends UIMessage = UIMessage>
  implements ChatTransport<UI_MESSAGE>
{
  constructor(private readonly threadKey: string) {}

  async sendMessages(options: {
    trigger: "submit-message" | "regenerate-message";
    chatId: string;
    messageId: string | undefined;
    messages: UI_MESSAGE[];
    abortSignal: AbortSignal | undefined;
  } & ChatRequestOptions): Promise<ReadableStream<UIMessageChunk>> {
    const lastMessage = options.messages[options.messages.length - 1];
    const text = lastMessage ? extractMessageText(lastMessage) : "";
    const body = (options.body ?? {}) as Record<string, unknown>;
    const harness =
      typeof body.harness === "string" && body.harness.trim().length > 0
        ? body.harness.trim()
        : undefined;
    if (text) {
      const executeRes = await fetch(`${BASE}/api/agent/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: options.abortSignal,
        body: JSON.stringify({
          slack_thread_key: this.threadKey,
          message: text,
          source: "thread_ui",
          ...(harness ? { harness } : {}),
        }),
      });
      if (!executeRes.ok) {
        throw new Error(await readErrorMessage(executeRes, `Execute failed (${executeRes.status})`));
      }
      const executeData = (await executeRes.json().catch(() => ({}))) as { error?: string };
      if (executeData.error) {
        throw new Error(String(executeData.error));
      }
    }

    return openUiStream(this.threadKey, options.abortSignal);
  }

  async reconnectToStream(options: {
    chatId: string;
  } & ChatRequestOptions): Promise<ReadableStream<UIMessageChunk> | null> {
    const abortSignal = (options as { abortSignal?: AbortSignal }).abortSignal;
    return openUiStream(this.threadKey, abortSignal);
  }
}
