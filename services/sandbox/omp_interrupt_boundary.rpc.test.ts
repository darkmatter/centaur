/**
 * Opt-in live regression: OMP's interrupted-request boundary survives process
 * replacement, an explicit `/retry`, and a following plain prompt.
 *
 * Skipped by default. With OMP_LIVE_TEST=1 it FAILS unless OMP_BIN points at an
 * absolute patched dist/cli.js of OMP 18.8.6 — a disposable private copy or the
 * image-global install. Credentials for the fixed provider/model must already be
 * configured.
 *
 *   OMP_LIVE_TEST=1 OMP_BIN=/abs/path/dist/cli.js \
 *     bun test services/sandbox/omp_interrupt_boundary.rpc.test.ts
 */
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  NativeOmp,
  abortedAssistants,
  asFrame,
  assistantEntries,
  hasTurnCancelledRecord,
  isCompletedAssistant,
  modelOutputFrames,
  newId,
  newToken,
  poll,
  readSession,
  recordText,
  toolCounts,
  transcriptFiles,
  userEntriesWith,
  type Frame,
} from "./omp_interrupt_boundary_live";

const LIVE = process.env.OMP_LIVE_TEST === "1";
const TOTAL_MS = 240_000;
const ACK_MS = 60_000;
const REPLY_MS = 90_000;
const PERSIST_MS = 15_000;

const children: NativeOmp[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(child => child.stop()));
});

function requirePatchedOmp(): string {
  const bin = process.env.OMP_BIN;
  if (!bin) {
    throw new Error(
      "OMP_LIVE_TEST=1 requires OMP_BIN=<absolute patched 18.8.6 dist/cli.js>",
    );
  }
  expect(isAbsolute(bin)).toBe(true);
  const real = realpathSync(bin);
  expect(real.endsWith(`${sep}dist${sep}cli.js`)).toBe(true);
  const manifest = JSON.parse(
    readFileSync(join(dirname(real), "..", "package.json"), "utf8"),
  ) as { name?: string; version?: string };
  expect(manifest.name).toBe("@oh-my-pi/pi-coding-agent");
  expect(manifest.version).toBe("18.8.6");
  const sha256 = createHash("sha256").update(readFileSync(real)).digest("hex");
  expect(sha256).not.toBe("89ed2ed1c51586f18ce424b46cab113cd01b2b98330202cd192f08968220edc6");
  return real;
}

function isolated(label: string) {
  const root = mkdtempSync(join(tmpdir(), `omp-live-${label}-`));
  const cwd = join(root, "cwd");
  const sessionDir = join(root, "sessions");
  mkdirSync(cwd);
  mkdirSync(sessionDir);
  return { cwd, sessionDir, deadline: Date.now() + TOTAL_MS };
}

function spawn(role: string, ompBin: string, cwd: string, deadline: number): NativeOmp {
  const child = NativeOmp.start(role, ompBin, cwd, deadline);
  children.push(child);
  return child;
}

function plainPrompt(token: string): string {
  return "Reply with exactly this token and nothing else: " + token;
}

function completed(records: Frame[]): Frame[] {
  return assistantEntries(records).filter(isCompletedAssistant);
}

function expectExactReply(records: Frame[], token: string) {
  const replies = completed(records);
  expect(replies.length).toBeGreaterThan(0);
  expect(recordText(replies[replies.length - 1]!).trim()).toBe(token);
}

function expectNoLeak(records: Frame[], token: string) {
  expect(records.some(entry => recordText(entry).includes(token))).toBe(false);
}

function expectNoPersistedMarker(records: Frame[]) {
  expect(hasTurnCancelledRecord(records)).toBe(false);
}

function expectStrictAppend(sessionFile: string, before: Uint8Array) {
  const after = readFileSync(sessionFile);
  expect(after.subarray(0, before.length).equals(before)).toBe(true);
  expect(after.length).toBeGreaterThan(before.length);
}

// Resume may append metadata (`model_change`, thinking level), never conversation.
function expectMetadataOnlyAppend(sessionFile: string, before: Uint8Array, tokens: string[]) {
  const after = readFileSync(sessionFile);
  expect(after.subarray(0, before.length).equals(before)).toBe(true);
  const appended = after.subarray(before.length).toString("utf8");
  const records = appended.split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as Frame);
  for (const record of records) expect(["message", "custom_message"]).not.toContain(record.type);
  expect(hasTurnCancelledRecord(records)).toBe(false);
  for (const token of tokens) expect(appended).not.toContain(token);
  return after;
}

async function waitForCompleted(sessionFile: string, beforeCount: number, deadline: number) {
  const hit = await poll(
    () => {
      const records = readSession(sessionFile);
      return completed(records.slice(beforeCount)).length > 0 ? records : null;
    },
    PERSIST_MS,
    deadline,
  );
  const records = hit ?? readSession(sessionFile);
  return { records, appended: records.slice(beforeCount) };
}

/**
 * The exact early-abort shape: the user turn is journaled, no assistant/tool
 * output exists yet, abort is acknowledged, and the empty aborted assistant
 * record is retained. Returns the stopped process's journal snapshot.
 */
async function abortAdmittedTurn(label: string, ompBin: string, prompt: string, token: string) {
  const isolatedRoot = isolated(label);
  const gate = spawn(`${label}-gate`, ompBin, isolatedRoot.cwd, isolatedRoot.deadline);
  await gate.handshake(isolatedRoot.sessionDir);
  const since = gate.frames.length;
  await gate.send({ type: "prompt", id: newId(label, "prompt"), message: prompt });
  const admitted = await poll(
    () => {
      for (const sessionFile of transcriptFiles(isolatedRoot.sessionDir)) {
        const records = readSession(sessionFile);
        const entries = userEntriesWith(records, token);
        if (entries.length > 0) return { sessionFile, records, entry: entries[0]! };
      }
      return null;
    },
    ACK_MS,
    isolatedRoot.deadline,
  );
  expect(admitted).not.toBeNull();
  const { sessionFile, records, entry } = admitted!;
  expect(recordText(entry)).toContain(token);
  expect(assistantEntries(records)).toHaveLength(0);
  expect(toolCounts(records)).toEqual({ calls: 0, results: 0 });
  expect(modelOutputFrames(gate.frames.slice(since))).toHaveLength(0);
  const admittedBytes = readFileSync(sessionFile);
  await gate.request("abort", {}, { id: newId(label, "abort"), timeoutMs: ACK_MS });
  const aborted = await poll(
    () => {
      const current = readSession(sessionFile);
      return abortedAssistants(current).length > 0 ? current : null;
    },
    PERSIST_MS,
    isolatedRoot.deadline,
  );
  expect(aborted).not.toBeNull();
  await gate.stop();
  expectStrictAppend(sessionFile, admittedBytes);
  const finalRecords = readSession(sessionFile);
  const abortedEntries = abortedAssistants(finalRecords);
  expect(abortedEntries).toHaveLength(1);
  const abortedMessage = asFrame(abortedEntries[0]!.message);
  expect(abortedMessage?.content).toEqual([]);
  expect(abortedMessage?.errorMessage === "Interrupted by user" || (Number(abortedMessage?.errorId) & 0x4000000) !== 0).toBe(true);
  expect(userEntriesWith(finalRecords, token)).toHaveLength(1);
  expectNoPersistedMarker(finalRecords);
  return {
    ...isolatedRoot,
    sessionFile,
    bytes: readFileSync(sessionFile),
  };
}

async function freshTurn(
  role: string,
  ompBin: string,
  state: { cwd: string; sessionDir: string; deadline: number; sessionFile: string },
  expectedFile: string,
  message: string,
  expectBuiltinAgent: boolean,
  expectedBytes: Uint8Array,
  forbiddenTokens: string[],
) {
  const child = spawn(role, ompBin, state.cwd, state.deadline);
  const opened = await child.handshake(state.sessionDir);
  expect(opened.cancelled).not.toBe(true);
  expect(opened.resumed).toBe(true);
  const sameFile =
    typeof opened.sessionFile === "string"
      ? resolve(opened.sessionFile) === resolve(expectedFile)
      : transcriptFiles(state.sessionDir).includes(expectedFile);
  expect(sameFile).toBe(true);
  const beforeBytes = expectMetadataOnlyAppend(state.sessionFile, expectedBytes, forbiddenTokens);
  const beforeCount = readSession(state.sessionFile).length;
  const since = child.frames.length;
  const request = await child.request(
    "prompt",
    { message },
    { id: newId(role, "prompt"), timeoutMs: ACK_MS },
  );
  if (expectBuiltinAgent) expect(request.data.agentInvoked).toBe(true);
  else expect(request.data.agentInvoked).toBeUndefined();
  const result = await child.promptResult(request.id, since, REPLY_MS);
  expect(result).not.toBeNull();
  expect(result!.status).toBe("completed");
  await waitForCompleted(state.sessionFile, beforeCount, state.deadline);
  await child.stop();
  expectStrictAppend(state.sessionFile, beforeBytes);
  const records = readSession(state.sessionFile);
  return {
    records,
    appended: records.slice(beforeCount),
    bytes: readFileSync(state.sessionFile),
  };
}

test.skipIf(!LIVE)("early tool-call abort stays out of the next fresh turn", async () => {
  const ompBin = requirePatchedOmp();
  const abortToken = newToken("ABORT");
  const bgToken = newToken("BG");
  const prompt =
    "Use your shell tool to run exactly `sleep 60`. " +
    "After it returns, reply with exactly this token and nothing else: " +
    abortToken;
  const state = await abortAdmittedTurn("early-abort", ompBin, prompt, abortToken);
  const settled = await freshTurn(
    "early-abort-follow",
    ompBin,
    state,
    state.sessionFile,
    plainPrompt(bgToken),
    false,
    state.bytes,
    [abortToken, bgToken],
  );
  expect(userEntriesWith(settled.appended, bgToken)).toHaveLength(1);
  expectExactReply(settled.appended, bgToken);
  expect(toolCounts(settled.appended)).toEqual({ calls: 0, results: 0 });
  expectNoLeak(settled.appended, abortToken);
  expectNoPersistedMarker(settled.records);
  expect(userEntriesWith(settled.records, abortToken)).toHaveLength(1);
  expect(abortedAssistants(settled.records)).toHaveLength(1);
  expect(recordText(abortedAssistants(settled.records)[0]!)).toBe("");
}, TOTAL_MS + 10_000);

test.skipIf(!LIVE)("explicit /retry replays the interrupted request exactly once", async () => {
  const ompBin = requirePatchedOmp();
  const retryToken = newToken("RETRY_A");
  const controlToken = newToken("RETRY_B");
  const state = await abortAdmittedTurn("retry", ompBin, plainPrompt(retryToken), retryToken);
  const retried = await freshTurn(
    "retry-explicit",
    ompBin,
    state,
    state.sessionFile,
    "/retry",
    true,
    state.bytes,
    [retryToken],
  );
  expect(completed(retried.appended)).toHaveLength(1);
  expectExactReply(retried.appended, retryToken);
  expect(toolCounts(retried.appended)).toEqual({ calls: 0, results: 0 });
  expectNoPersistedMarker(retried.records);
  expect(userEntriesWith(retried.records, retryToken)).toHaveLength(1);
  const aborted = abortedAssistants(retried.records);
  expect(aborted).toHaveLength(1);
  expect(recordText(aborted[0]!)).toBe("");
  const control = await freshTurn(
    "retry-control",
    ompBin,
    state,
    state.sessionFile,
    plainPrompt(controlToken),
    false,
    retried.bytes,
    [retryToken, controlToken],
  );
  expectExactReply(control.appended, controlToken);
  expect(toolCounts(control.appended)).toEqual({ calls: 0, results: 0 });
  expectNoLeak(control.appended, retryToken);
  expectNoPersistedMarker(control.records);
  expect(userEntriesWith(control.records, retryToken)).toHaveLength(1);
  expect(userEntriesWith(control.records, controlToken)).toHaveLength(1);
  expect(abortedAssistants(control.records)).toHaveLength(1);
}, TOTAL_MS + 10_000);
