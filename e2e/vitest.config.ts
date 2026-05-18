import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../services/slackbot/src", import.meta.url)),
    },
  },
  test: {
    include: ["scenarios/**/*.e2e.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
