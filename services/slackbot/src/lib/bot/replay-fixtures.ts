/**
 * Replay real Amp SSE fixtures through normalizeHarnessEvent + ProgressTracker.
 *
 * Validates that:
 * 1. Every fixture produces a non-empty finalMessage (unless it's a handoff/error)
 * 2. Preamble text before tool calls is never the finalMessage
 * 3. resultText matches turn.done result when present
 * 4. All tool_use events produce task_update chunks
 * 5. The tracker state is consistent at the end
 *
 * Run:  node --experimental-strip-types services/slackbot/src/lib/bot/replay-fixtures.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Import the real normalizer and real ProgressTracker ─────────────────────
import { normalizeHarnessEvent } from "../../../../../packages/harness-events/src/normalize";
import type { CanonicalEvent } from "../../../../../packages/harness-events/src/types";
import { ProgressTracker } from "./progress-tracker";

// ── SSE parser ──────────────────────────────────────────────────────────────

function parseSSEFile(filePath: string): Record<string, unknown>[] {
  const raw = fs.readFileSync(filePath, "utf-8");
  const events: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data: ")) continue;
    const payload = trimmed.slice(6);
    if (payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      // skip unparseable lines
    }
  }
  return events;
}

// ── Test runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

function replayFixture(name: string): {
  tracker: ProgressTracker;
  allCanonical: CanonicalEvent[];
  allChunks: StreamChunk[];
  rawEvents: Record<string, unknown>[];
  turnDoneResult: string;
} {
  const filePath = path.join(__dirname, "fixtures", `${name}.sse`);
  const rawEvents = parseSSEFile(filePath);
  const tracker = new ProgressTracker();
  const allCanonical: CanonicalEvent[] = [];
  const allChunks: StreamChunk[] = [];
  let turnDoneResult = "";

  for (const raw of rawEvents) {
    // Capture turn.done result before normalization (it's not a canonical event)
    if (raw.type === "turn.done") {
      const r = raw.result;
      turnDoneResult = typeof r === "string" ? r : "";
    }

    const canonical = normalizeHarnessEvent("amp", raw);
    for (const ce of canonical) {
      allCanonical.push(ce);
      if (tracker.update(ce)) {
        allChunks.push(...tracker.pendingChunks());
      }
    }
  }

  return { tracker, allCanonical, allChunks, rawEvents, turnDoneResult };
}

function finalMessage(t: ProgressTracker): string {
  return (t.resultText || t.lastAssistantText).trim();
}

// ── Load fixtures ───────────────────────────────────────────────────────────

const fixtureDir = path.join(__dirname, "fixtures");
const fixtureFiles = fs.readdirSync(fixtureDir).filter(f => f.endsWith(".sse")).sort();

console.log(`\nFound ${fixtureFiles.length} fixtures in ${fixtureDir}\n`);

// ═══════════════════════════════════════════════════════════════════════════
// Per-fixture tests
// ═══════════════════════════════════════════════════════════════════════════

for (const file of fixtureFiles) {
  const name = file.replace(".sse", "");
  console.log(`\n── ${name} ──`);

  const { tracker, allCanonical, allChunks, rawEvents, turnDoneResult } = replayFixture(name);
  const fm = finalMessage(tracker);

  // 1. We should have parsed some events
  test("parsed raw SSE events", () => {
    assert.ok(rawEvents.length > 0, `no events in ${file}`);
  });

  // 2. Normalizer produced canonical events
  test("normalizer produced canonical events", () => {
    assert.ok(allCanonical.length > 0, `no canonical events from ${file}`);
  });

  // 3. If there were tool_use events, there should be task_update chunks
  const toolUseEvents = allCanonical.filter(
    e => e.type === "assistant" && e.message?.content.some(b => b.type === "tool_use")
  );
  if (toolUseEvents.length > 0) {
    test(`${toolUseEvents.length} tool_use event(s) → task_update chunks`, () => {
      const taskUpdates = allChunks.filter(c => c.type === "task_update" && c.id !== "init");
      assert.ok(taskUpdates.length > 0, "no task_update chunks for tool_use events");
    });
  }

  // 4. If turn.done has a result, finalMessage should match it.
  //    Note: turn.done is NOT a canonical event — the normalizer doesn't produce
  //    a "result" event from it. The harness layer (readSSEStream) handles it
  //    directly. The tracker gets the same text via lastAssistantText from the
  //    final assistant event (which matches turn.done.result for well-formed turns).
  if (turnDoneResult) {
    test("finalMessage matches turn.done result", () => {
      assert.equal(fm, turnDoneResult);
    });
  }

  // 5. finalMessage should be non-empty for complete turns (not handoffs or errors)
  const isHandoff = name === "handoff";
  const hasError = allCanonical.some(e => e.type === "error");
  if (!isHandoff && turnDoneResult) {
    test("finalMessage is non-empty", () => {
      assert.ok(fm.length > 0, `finalMessage was empty for ${name}`);
    });
  }

  // 6. THE KEY TEST: finalMessage should NOT be preamble text
  //    If there were tool_use events, the final message should NOT be
  //    whatever text appeared before the first tool call
  if (toolUseEvents.length > 0 && fm) {
    test("finalMessage is NOT preamble (text before tool calls)", () => {
      // Find the first text event that appeared before any tool_use
      let firstTextBeforeTool = "";
      let seenToolUse = false;
      for (const ce of allCanonical) {
        if (ce.type === "assistant" && ce.message?.content) {
          for (const block of ce.message.content) {
            if (block.type === "text" && block.text && !seenToolUse) {
              firstTextBeforeTool = block.text;
            }
            if (block.type === "tool_use") {
              seenToolUse = true;
            }
          }
        }
      }
      // If there was preamble text before tool calls, it should NOT be the final message
      // (unless the turn completed and the same text is also the final answer — which
      //  would only happen if the model said the same thing before AND after tools)
      if (firstTextBeforeTool && firstTextBeforeTool !== turnDoneResult) {
        assert.notEqual(fm, firstTextBeforeTool,
          `finalMessage equals preamble text: "${firstTextBeforeTool.slice(0, 60)}..."`);
      }
    });
  }

  // 7. All active tools should be resolved at end (complete turn)
  if (turnDoneResult) {
    test("no dangling active tools at end", () => {
      const activeTools = (tracker as any).activeTools as Map<string, unknown>;
      assert.equal(activeTools.size, 0,
        `${activeTools.size} tool(s) still active: ${[...activeTools.keys()]}`);
    });
  }

  // 8. Print summary
  const toolNames = toolUseEvents.flatMap(
    e => e.type === "assistant" ? e.message.content.filter(b => b.type === "tool_use").map(b => (b as any).name) : []
  );
  console.log(`    events: ${allCanonical.length} canonical, ${allChunks.length} chunks, tools: [${toolNames.join(", ")}]`);
  console.log(`    final: "${fm.slice(0, 80)}${fm.length > 80 ? "…" : ""}"`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Simulated stream-death tests using real fixture data
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n\n── Simulated stream deaths (truncated real data) ──");

// For each fixture with tool calls, simulate the stream dying after the
// first tool_use but before the tool result
for (const file of fixtureFiles) {
  const name = file.replace(".sse", "");
  const filePath = path.join(fixtureDir, file);
  const rawEvents = parseSSEFile(filePath);

  // Find first assistant event with tool_use
  let firstToolUseIdx = -1;
  for (let i = 0; i < rawEvents.length; i++) {
    const canonical = normalizeHarnessEvent("amp", rawEvents[i]);
    for (const ce of canonical) {
      if (ce.type === "assistant" && ce.message?.content.some(b => b.type === "tool_use")) {
        firstToolUseIdx = i;
        break;
      }
    }
    if (firstToolUseIdx >= 0) break;
  }

  if (firstToolUseIdx < 0) continue; // no tool calls in this fixture

  test(`stream-death:${name} — EOF after first tool_use → no bogus message`, () => {
    const tracker = new ProgressTracker();
    // Replay only up to and including the first tool_use event
    for (let i = 0; i <= firstToolUseIdx; i++) {
      const canonical = normalizeHarnessEvent("amp", rawEvents[i]);
      for (const ce of canonical) {
        tracker.update(ce);
        tracker.pendingChunks(); // drain
      }
    }
    const fm = finalMessage(tracker);
    assert.equal(fm, "", `stream-death:${name} produced "${fm.slice(0, 60)}" instead of empty`);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n${"═".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("All tests passed ✓\n");
