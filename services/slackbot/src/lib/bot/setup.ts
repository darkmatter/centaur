import { Chat } from "chat";
import { createSlackAdapter, type SlackAdapter } from "@chat-adapter/slack";
import { createPostgresState } from "@chat-adapter/state-pg";
import { Pool } from "pg";
import { SlackBot } from "./bot";

const hasSlackCreds = Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET);

let _instance: { chat: Chat; bot: SlackBot } | null = null;

function create() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

  const chat = new Chat({
    userName: process.env.SLACK_BOT_USERNAME || "ai-agent",
    adapters: hasSlackCreds ? { slack: createSlackAdapter() } : {},
    state: createPostgresState({ client: pool }),
    onLockConflict: "force",
  } as ConstructorParameters<typeof Chat>[0]);

  const slack = hasSlackCreds ? chat.getAdapter("slack") as SlackAdapter : undefined;
  const bot = SlackBot.createFromEnv(slack as any);

  chat.onNewMention((t, m) => bot.onNewMention(t as any, m as any));
  chat.onSubscribedMessage((t, m) => bot.onSubscribedMessage(t as any, m as any));

  return { chat, bot };
}

export function getBot() {
  if (!_instance) _instance = create();
  return _instance.chat;
}

export function getSlackBootstrapState() {
  const required = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"] as const;
  const missing = required.filter((k) => !process.env[k]?.trim());
  return { ready: missing.length === 0, missingEnvKeys: [...missing] };
}
