export class TerminalAnswer {
  private terminalText = "";
  private readonly finalAnswerIds = new Set<string>();
  private finalAnswerText = "";

  async *collectSource<Event>(
    stream: AsyncIterable<Event>,
  ): AsyncIterable<Event> {
    for await (const event of stream) {
      this.captureTerminalText(event);
      yield event;
    }
  }

  text(): string {
    return this.terminalText.trim();
  }

  private captureTerminalText(event: unknown): void {
    if (!event || typeof event !== "object") return;
    const eventKind = String(
      "eventKind" in event
        ? event.eventKind
        : "event" in event
          ? event.event
          : "",
    );
    const data = "data" in event ? parseTerminalEventData(event.data) : event;
    if (eventKind === "session.output.line") this.captureFinalAnswer(data);
    if (
      eventKind !== "session.execution_completed" &&
      eventKind !== "session.execution_cancelled" &&
      !(eventKind === "session.output.line" && isTerminalCodexAppServerEvent(data)) &&
      !isTerminalCodexAppServerEvent(event)
    ) {
      return;
    }
    const text = terminalResultText(data) || this.finalAnswerText;
    if (text) this.terminalText = text;
  }

  private captureFinalAnswer(data: unknown): void {
    if (!data || typeof data !== "object") return;
    const notification = data as { method?: unknown; params?: unknown };
    if (!notification.params || typeof notification.params !== "object") return;
    const params = notification.params as Record<string, unknown>;
    if (notification.method === "item/started" && params.item && typeof params.item === "object") {
      const item = params.item as Record<string, unknown>;
      if (item.phase === "final_answer" && typeof item.id === "string") {
        this.finalAnswerIds.add(item.id);
      }
    }
    if (
      notification.method === "item/agentMessage/delta" &&
      typeof params.itemId === "string" &&
      this.finalAnswerIds.has(params.itemId) &&
      typeof params.delta === "string"
    ) {
      this.finalAnswerText += params.delta.slice(0, 8_000 - this.finalAnswerText.length);
    }
  }
}

function parseTerminalEventData(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

function isTerminalCodexAppServerEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const type = (event as { type?: unknown; method?: unknown }).type;
  if ((event as { method?: unknown }).method === "turn/completed") return true;
  return type === "result" || type === "turn.done" || type === "turn.completed";
}

function terminalResultText(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  for (const key of ["result", "result_text", "text", "final_text"]) {
    const value = (event as Record<string, unknown>)[key];
    if (typeof value !== "string") continue;
    const resultText = value.trim();
    if (resultText) return resultText;
  }
  return "";
}
