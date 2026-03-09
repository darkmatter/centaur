import { createClient, type RedisClientType } from "redis";
import type { BudgetMode, Engine, Harness } from "./harness";

const REDIS_URL = process.env.REDIS_URL || "";
const KEY_PREFIX = "ai_v2:threadConfig:";
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export type ThreadConfig = {
  harness: Harness;
  engine: Engine | null;
  model: string | null;
  budgetMode: BudgetMode | null;
};

let _redis: RedisClientType | null = null;

async function getRedis(): Promise<RedisClientType | null> {
  if (!REDIS_URL) return null;
  if (_redis?.isOpen) return _redis;
  try {
    _redis = createClient({ url: REDIS_URL }) as RedisClientType;
    _redis.on("error", () => {});
    await _redis.connect();
    return _redis;
  } catch {
    _redis = null;
    return null;
  }
}

export async function getThreadConfig(
  threadKey: string,
): Promise<ThreadConfig | undefined> {
  const redis = await getRedis();
  if (!redis) return undefined;
  try {
    const raw = await redis.get(`${KEY_PREFIX}${threadKey}`);
    if (!raw) return undefined;
    return JSON.parse(raw) as ThreadConfig;
  } catch {
    return undefined;
  }
}

export async function setThreadConfig(
  threadKey: string,
  config: ThreadConfig,
): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  try {
    await redis.set(`${KEY_PREFIX}${threadKey}`, JSON.stringify(config), {
      EX: TTL_SECONDS,
    });
  } catch {
    // Best-effort — Redis failure should never break the bot.
  }
}

export async function deleteThreadConfig(threadKey: string): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  try {
    await redis.del(`${KEY_PREFIX}${threadKey}`);
  } catch {
    // Best-effort.
  }
}
