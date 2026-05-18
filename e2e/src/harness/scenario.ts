import { CentaurClient } from "@centaur/api-client";

import { MockSlackbot } from "../drivers/mock-slackbot";
import { E2EMetrics } from "./metrics";

export type E2EContext = {
  apiUrl: string;
  apiKey: string;
  client: CentaurClient;
  metrics: E2EMetrics;
  mockSlackbot: () => MockSlackbot;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for E2E tests`);
  }
  return value;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForApiReady(apiUrl: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiUrl.replace(/\/$/, "")}/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}: ${await response.text().catch(() => "")}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1_000);
  }
  throw new Error(`API did not become ready within ${timeoutMs}ms: ${lastError}`);
}

export async function createE2EContext(): Promise<E2EContext> {
  const apiUrl = requiredEnv("CENTAUR_API_URL").replace(/\/$/, "");
  const apiKey = requiredEnv("SLACKBOT_API_KEY");
  const metrics = new E2EMetrics();
  metrics.mark("start");

  await waitForApiReady(apiUrl);
  metrics.mark("apiReady");

  const client = new CentaurClient({ apiUrl, apiKey });
  return {
    apiUrl,
    apiKey,
    client,
    metrics,
    mockSlackbot: () => new MockSlackbot(client, metrics),
  };
}
