import crypto from "node:crypto";
import { Chat, parseMarkdown, type Root } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
import { createMemoryState } from "@chat-adapter/state-memory";
import {
  executeStream,
  extractRunOptions,
  replyEngineerFlow,
  startEngineerFlow,
  type AgentMode,
  type FileAttachment,
  type ProgressEvent,
} from "./harness";

const THREAD_VIEWER_URL = process.env.THREAD_VIEWER_URL || "https://svc-ai.paradigm.xyz";
const MAX_TRACKED_THREAD_MODES = 500;

type MarkdownNode = Root | Root["children"][number];
type ThreadModeConfig = { mode: AgentMode; modelPreference: string | null };

function renderSlackMessage(markdown: string) {
  const ast = parseMarkdown(markdown);
  const escapeLiteralTildes = (
    node: MarkdownNode,
    inDelete = false
  ): void => {
    const insideDelete = inDelete || node.type === "delete";

    if (node.type === "text" && !insideDelete) {
      // Slack treats paired single tildes as strikethrough; escape literal tildes.
      node.value = node.value.replace(/~/g, "\\~");
    }

    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children as Root["children"]) {
        escapeLiteralTildes(child, insideDelete);
      }
    }
  };

  escapeLiteralTildes(ast);

  return { ast };
}

function createBot() {
  const hasSlackCreds =
    process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET;

  const bot = new Chat({
    userName: "ai",
    adapters: hasSlackCreds ? { slack: createSlackAdapter() } : {},
    state: process.env.REDIS_URL ? createRedisState() : createMemoryState(),
  });
  const threadModes = new Map<string, ThreadModeConfig>();

  function setThreadMode(threadKey: string, config: ThreadModeConfig): void {
    if (!threadModes.has(threadKey) && threadModes.size >= MAX_TRACKED_THREAD_MODES) {
      const oldestKey = threadModes.keys().next().value as string | undefined;
      if (oldestKey) threadModes.delete(oldestKey);
    }
    threadModes.set(threadKey, config);
  }

  function buildSessionContext(threadId: string): string {
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    return [
      "# Session Context",
      "",
      `- **Date/Time**: ${now} UTC`,
      `- **Thread ID**: ${threadId}`,
      `- **Platform**: Slack`,
      "",
      "## Formatting Rules",
      "",
      "- Use standard markdown: **bold**, _italic_, `code`, [text](url)",
      "- Do NOT use Slack-specific `<URL|text>` link format — use `[text](url)` instead",
      "- Preserve Slack user mentions (`<@UXXXXXXX>`) exactly as-is",
      "- Keep responses under 4,000 characters — split long responses or summarize",
      "- After completing a long task, tag the requester with `@username`",
      "",
      "---",
      "",
    ].join("\n");
  }

  async function handleMessage(
    thread: Parameters<Parameters<typeof bot.onNewMention>[0]>[0],
    messageText: string,
    isFirstMessage: boolean,
    attachments?: Array<{ url?: string; name?: string }>
  ) {
    const parsed = extractRunOptions(messageText);
    const requestId = crypto.randomUUID().slice(0, 8);
    const threadKey = thread.id;
    const previous = threadModes.get(threadKey);
    const files: FileAttachment[] = (attachments || [])
      .filter((a): a is { url: string; name: string } => !!a.url && !!a.name)
      .map((a) => ({ url: a.url, name: a.name }));

    const mode: AgentMode = isFirstMessage
      ? parsed.mode
      : (previous?.mode ?? parsed.mode);

    if (
      !isFirstMessage &&
      previous &&
      parsed.modeExplicit &&
      parsed.mode !== previous.mode
    ) {
      await thread.post(
        renderSlackMessage(
          "This thread is already running in a different mode. Start a new thread to switch modes."
        )
      );
      return;
    }

    if (!parsed.cleanedText) {
      await thread.post(
        renderSlackMessage(
          "Please provide a prompt after flags. Example: `@tempo-ai --eng --claude implement retry logic`"
        )
      );
      return;
    }

    if (mode === "eng") {
      const modelPreference =
        parsed.modelPreference ?? parsed.harness ?? previous?.modelPreference ?? null;
      setThreadMode(threadKey, { mode: "eng", modelPreference });

      if (isFirstMessage) {
        try {
          await thread.startTyping("Starting engineer flow...");
          const result = await startEngineerFlow(
            threadKey,
            parsed.cleanedText,
            modelPreference,
            files.length > 0 ? files : undefined
          );
          const viewerUrl = `${THREAD_VIEWER_URL}/threads/${encodeURIComponent(threadKey)}`;
          const preferenceLine = modelPreference
            ? `\nModel preference: \`${modelPreference}\``
            : "";
          const statusLine =
            result.status === "already_running"
              ? "Engineer flow is already running for this thread."
              : "Engineer flow started.";
          await thread.post(
            renderSlackMessage(
              `${statusLine}${preferenceLine}\n\n[🔗 Thread Viewer](${viewerUrl})`
            )
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : "unknown error";
          await thread.post(
            renderSlackMessage(`Failed to start engineer flow: ${msg}`)
          );
        }
        return;
      }

      try {
        const reply = await replyEngineerFlow(
          threadKey,
          parsed.cleanedText,
          files.length > 0 ? files : undefined
        );
        if (reply.status === "no_active_session") {
          await thread.post(
            renderSlackMessage(
              "No active engineer session for this thread. Start a new run with `--eng`."
            )
          );
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : "unknown error";
        await thread.post(
          renderSlackMessage(`Failed to send engineer reply: ${msg}`)
        );
      }
      return;
    }

    setThreadMode(threadKey, { mode: "default", modelPreference: null });
    const harness = parsed.harness ?? "amp";
    const viewerUrl = `${THREAD_VIEWER_URL}/threads/${encodeURIComponent(threadKey)}`;

    // Post thread viewer link instantly, start native typing indicator
    const statusMsg = await thread.post(
      renderSlackMessage(`[🔗 Thread Viewer](${viewerUrl})`)
    );
    await thread.startTyping("Thinking...");

    let activeTools: string[] = [];
    let editQueued = false;

    function queueEdit() {
      if (editQueued) return;
      editQueued = true;
      setTimeout(() => {
        editQueued = false;
        const toolLines = activeTools.map((t) => `  🔧 ${t}`).join("\n");
        const text = toolLines
          ? `${toolLines}\n\n[🔗 Thread Viewer](${viewerUrl})`
          : `[🔗 Thread Viewer](${viewerUrl})`;
        statusMsg.edit(renderSlackMessage(text)).catch(() => {});
      }, 300);
    }

    const message = isFirstMessage
      ? buildSessionContext(threadKey) + parsed.cleanedText
      : parsed.cleanedText;

    const result = await executeStream(
      threadKey,
      message,
      harness,
      requestId,
      files.length > 0 ? files : undefined,
      (event) => {
        if (event.type === "tool_use" || event.type === "tool_call") {
          const name = (event.name || event.tool || "") as string;
          if (name && !activeTools.includes(name)) {
            activeTools.push(name);
            if (activeTools.length > 5) activeTools.shift();
            const status = activeTools.map((t) => `🔧 ${t}`).join("  ");
            thread.startTyping(status).catch(() => {});
            queueEdit();
          }
        }
        if (event.type === "tool_result" || event.type === "tool_output") {
          const name = (event.name || event.tool || "") as string;
          activeTools = activeTools.filter((t) => t !== name);
          const status = activeTools.length > 0
            ? activeTools.map((t) => `🔧 ${t}`).join("  ")
            : "Thinking...";
          thread.startTyping(status).catch(() => {});
          queueEdit();
        }
      },
    );

    const finalText = isFirstMessage
      ? `${result}\n\n[🔗 Thread Viewer](${viewerUrl})`
      : result;
    await statusMsg.edit(renderSlackMessage(finalText));
    await thread.startTyping("").catch(() => {});
  }

  bot.onNewMention(async (thread, message) => {
    if (message.author.isMe) return;
    thread.subscribe().catch(() => {});
    const attachments = message.attachments?.map((a) => ({ url: a.url, name: a.name }));
    await handleMessage(thread, message.text, true, attachments);
  });

  bot.onSubscribedMessage(async (thread, message) => {
    if (message.author.isMe) return;
    if (!message.isMention) return;
    const attachments = message.attachments?.map((a) => ({ url: a.url, name: a.name }));
    await handleMessage(thread, message.text, false, attachments);
  });

  return bot;
}

let _bot: ReturnType<typeof createBot> | null = null;
export function getBot() {
  if (!_bot) _bot = createBot();
  return _bot;
}
