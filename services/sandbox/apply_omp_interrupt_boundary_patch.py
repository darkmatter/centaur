#!/usr/bin/env python3
"""Apply Centaur's OMP 18.8.6 interrupted-request context patch.

OMP 18.8.6 rebuilds model context without error/aborted assistant turns. A user
interrupt that produced no output therefore leaves the preceding request in the
restored context as unanswered work, and the next prompt reads as a continuation
of it. `convertToLlm` independently drops the same empty assistant shape, so
keeping the turn would not fix it either.

This patch keeps native history untouched and, only while rebuilding context,
replaces that exact shape -- an empty assistant with `stopReason: "aborted"`,
the user-interrupt marker, no request controls, a user-authored predecessor, and
no assistant reply following -- with a hidden native `custom` message that names
the cancellation boundary. The LLM projection turns that marker into a
synthetic assistant cancellation receipt (fixed text, zero usage, the original
api/provider/model and timestamp, `stopReason: "stop"`) only when a later
non-empty conversational turn follows it before any assistant. A developer note
would not be a structural boundary on Anthropic, which serializes it as a wire
user turn and merges consecutive user turns; a trailing receipt would be the
last wire assistant and invite a `Continue.` pad. Conversion caches key on this
projection and remember a pending marker so an appended prompt reconverts it.
Tool-batch interrupts (whose context ends in the failed tool result) therefore
keep their replayable shape, a later successful answer keeps its request/reply
pair, and the explicit retry path drops the marker from the rebuilt context
before continuing. The persisted JSONL entries, the transcript view, partial
assistant turns, provider errors, and the interrupted-thinking continuity pair
are unchanged.

The package is version-pinned and checked against the official tarball's file
hashes and exact source anchors before anything is written. Any drift fails.

The container build applies this once to the package it just installed globally
in the same layer, after deleting Bun's install cache; atomic replacement breaks
Bun's hardlinks, so patching there cannot mutate a shared cache, and a symlinked
package root is rejected. Developer and CI use MUST patch a disposable private
copy instead, never an active host's global install.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import sys
import tempfile
from pathlib import Path

PACKAGE_NAME = "@oh-my-pi/pi-coding-agent"
SUPPORTED_VERSION = "18.8.6"
# `@oh-my-pi/pi-coding-agent@18.8.6` tarball integrity from the official registry
# (bun.lock): sha512-SrfEyTBqlrCJdgfd1YFN393QAdnaOLLCqj/11Tb+kpQA9GBzwPEg41ISz65MbIR7EDo52xQCaSo/smaP8NPtSg==
OFFICIAL_SHA256 = {
    "dist/cli.js": "89ed2ed1c51586f18ce424b46cab113cd01b2b98330202cd192f08968220edc6",
    "src/session/messages.ts": "9ee21370941c9756cf9b9ab4cabcac0d04bad817d09f957995d20e32cf192f7d",
    "src/session/session-context.ts": "fd46dabf6a7324ccab7ed2ae95a1ed47e5f56b7be32c5f71424455d08825ce47",
    "src/session/turn-recovery.ts": "9c1d1dc16fac5df23cd80e6c3b0da5b997a16d98fef91ecf38f38946441bd181",
}

CANCELLATION_MESSAGE_TYPE = "turn-cancelled"
CANCELLATION_TEXT = (
    "The user interrupted the previous request before the assistant produced "
    "any output. That request was cancelled and is not complete; continue it "
    "only if the user explicitly asks to continue or restates the intent."
)
# Assistant receipt projected into the provider request in place of the marker.
# The marker stays hidden in agent state; only the rebuilt model context carries
# a real assistant turn, which is a structural boundary on every provider (a
# developer note is not: Anthropic serializes it as a wire user turn and merges
# consecutive user turns).
CANCELLATION_RECEIPT_TEXT = (
    "The previous request was cancelled by the user before any output was produced."
)
# The source patch and the bundle patch both receive exactly these literals, so
# the message is maintained once.
CANCELLATION_MESSAGE_LITERAL = json.dumps(CANCELLATION_MESSAGE_TYPE)
CANCELLATION_TEXT_LITERAL = json.dumps(CANCELLATION_TEXT)
CANCELLATION_RECEIPT_TEXT_LITERAL = json.dumps(CANCELLATION_RECEIPT_TEXT)

# src/session/session-context.ts:11-19 -- the session-context -> messages import.
SOURCE_IMPORT_ANCHOR = "\tisEmptyErrorTurn,\n\tPREWALK_PLAN_MESSAGE_TYPE,"
SOURCE_IMPORT_REPLACEMENT = (
    "\tisEmptyErrorTurn,\n\tisUserAuthoredMessage,\n\tisUserInterruptAbort,\n"
    "\tPREWALK_PLAN_MESSAGE_TYPE,\n\tUSER_INTERRUPT_CANCELLED_MESSAGE_TYPE,"
)

# src/session/session-context.ts:233 -- the exported public context builder.
SOURCE_HELPER_ANCHOR = "export function buildSessionContext("
SOURCE_HELPER = """/**
 * Hidden boundary for a restored user interrupt that produced no output.
 *
 * `convertToLlm` drops this assistant shape too, so keeping the turn is not an
 * option. The custom message records the cancellation in agent state; the LLM
 * projection turns it into a synthetic assistant receipt, because a custom
 * note becomes a developer/user turn that providers may merge with the
 * cancelled request. The original provider/model metadata is retained so the
 * receipt is a valid native assistant turn.
 */
const USER_INTERRUPT_CANCELLED_TEXT =
\t__CANCELLATION_TEXT_LITERAL__;

function userInterruptCancelledMessage(
\tmessage: AgentMessage & { role: "assistant" },
): AgentMessage {
\treturn createCustomMessage(
\t\tUSER_INTERRUPT_CANCELLED_MESSAGE_TYPE,
\t\tUSER_INTERRUPT_CANCELLED_TEXT,
\t\tfalse,
\t\t{
\t\t\tapi: message.api,
\t\t\tprovider: message.provider,
\t\t\tmodel: message.model,
\t\t},
\t\tnew Date(message.timestamp).toISOString(),
\t\t"agent",
\t);
}

"""
SOURCE_HELPER = (
    SOURCE_HELPER.replace("__CANCELLATION_MESSAGE_LITERAL__", CANCELLATION_MESSAGE_LITERAL)
    .replace("__CANCELLATION_TEXT_LITERAL__", CANCELLATION_TEXT_LITERAL)
)

# src/session/session-context.ts:744-771 -- the non-transcript error/abort drop
# loop.
SOURCE_SPLICE_ANCHOR = (
    "\t\t\tmessages.splice(i, 1);\n\t\t\tif (droppedToolCallIds.size > 0) {"
)
SOURCE_SPLICE_REPLACEMENT = (
    "\t\t\tif (\n"
    "\t\t\t\tisUserInterruptAbort(message) &&\n"
    '\t\t\t\tmessage.stopReason === "aborted" &&\n'
    "\t\t\t\tmessage.content.length === 0 &&\n"
    "\t\t\t\tmessage.requestControls === undefined &&\n"
    "\t\t\t\tmessages[i - 1] !== undefined &&\n"
    "\t\t\t\tisUserAuthoredMessage(messages[i - 1]) &&\n"
    '\t\t\t\tmessages[i + 1]?.role !== "assistant"\n'
    "\t\t\t) {\n"
    "\t\t\t\tmessages[i] = userInterruptCancelledMessage(message);\n"
    "\t\t\t} else {\n"
    "\t\t\t\tmessages.splice(i, 1);\n"
    "\t\t\t}\n"
    "\t\t\tif (droppedToolCallIds.size > 0) {"
)

# src/session/turn-recovery.ts:60 -- retry must recognize the boundary type.
# The marker constant now lives in `./messages` (the projection and the state
# marker share one definition), so extend the existing import there instead of
# creating a messages -> session-context cycle.
SOURCE_RETRY_IMPORT_ANCHOR = (
    'import { assistantTurnProducedOutput, isEmptyAssistantStop, isEmptyErrorTurn } from "./messages";'
)
SOURCE_RETRY_IMPORT_REPLACEMENT = (
    "import {\n"
    "\tassistantTurnProducedOutput,\n"
    "\tisEmptyAssistantStop,\n"
    "\tisEmptyErrorTurn,\n"
    "\tUSER_INTERRUPT_CANCELLED_MESSAGE_TYPE,\n"
    '} from "./messages";'
)

# src/session/turn-recovery.ts:3067-3073 -- retry()'s restored-session branch.
# Reopened agent state ends in the hidden `turn-cancelled` marker; it is rebuilt
# state, not history, so an explicit retry drops it from the active context
# before continuing. The persisted session is never rewritten.
SOURCE_RETRY_ANCHOR = (
    "\t\t\tconst replayStart = toolReplayStart(messages);\n"
    "\t\t\tif (replayStart !== undefined) await this.#stripForToolReplay(messages, replayStart);"
)
SOURCE_RETRY_REPLACEMENT = (
    "\t\t\tconst replayStart = toolReplayStart(messages);\n"
    "\t\t\tif (replayStart !== undefined) {\n"
    "\t\t\t\tawait this.#stripForToolReplay(messages, replayStart);\n"
    "\t\t\t} else {\n"
    "\t\t\t\tconst tail = messages[messages.length - 1];\n"
    "\t\t\t\tif (\n"
    "\t\t\t\t\ttail?.role === \"custom\" &&\n"
    "\t\t\t\t\ttail.customType === USER_INTERRUPT_CANCELLED_MESSAGE_TYPE\n"
    "\t\t\t\t) {\n"
    "\t\t\t\t\tthis.#host.agent.replaceMessages(messages.slice(0, -1));\n"
    "\t\t\t\t}\n"
    "\t\t\t}"
)

# src/session/messages.ts -- the marker definition and its provider projection.
# The state marker remains a hidden custom message; `convertToLlm` turns it into
# a synthetic assistant receipt only when a later non-empty conversational turn
# follows it. That restores a real turn boundary on every provider, including
# Anthropic, which serializes a developer note as a second wire user turn and
# merges consecutive user turns.
SOURCE_MESSAGES_HELPER_ANCHOR = (
    "function convertOne(m: AgentMessage, interruptedNext: boolean): Message[] {"
)
SOURCE_MESSAGES_ONE_ANCHOR = SOURCE_MESSAGES_HELPER_ANCHOR
SOURCE_MESSAGES_ONE_REPLACEMENT = """function convertOne(
\tm: AgentMessage,
\tinterruptedNext: boolean,
\tcancellationReceipt: boolean,
): Message[] {"""
SOURCE_MESSAGES_HELPER = """export const USER_INTERRUPT_CANCELLED_MESSAGE_TYPE = __CANCELLATION_MESSAGE_LITERAL__;
const USER_INTERRUPT_CANCELLED_RECEIPT_TEXT =
\t__CANCELLATION_RECEIPT_LITERAL__;

/** Non-empty content that survives the provider conversion of a user turn. */
function hasNonEmptyLlmContent(content: unknown): boolean {
\tif (typeof content === "string") return content.trim().length > 0;
\tif (!Array.isArray(content)) return false;
\treturn content.some(block => {
\t\tif (typeof block !== "object" || block === null) return false;
\t\tconst record = block as { type?: unknown; text?: unknown };
\t\tif (record.type === "image") return true;
\t\treturn (
\t\t\trecord.type === "text" &&
\t\t\ttypeof record.text === "string" &&
\t\t\trecord.text.trim().length > 0
\t\t);
\t});
}

/**
 * Whether this message produces a non-empty conversational (user/developer)
 * turn in the provider request. Filtered/empty messages convert to nothing on
 * the wire, so they cannot close the synthetic assistant receipt.
 */
function projectsConversationalTurn(message: AgentMessage): boolean {
\tswitch (message.role) {
\t\tcase "user":
\t\tcase "developer":
\t\t\treturn hasNonEmptyLlmContent(message.content);
\t\tcase "custom":
\t\tcase "hookMessage":
\t\t\treturn isCustomMessageContent(message.content) && hasNonEmptyLlmContent(message.content);
\t\tcase "bashExecution":
\t\tcase "pythonExecution":
\t\t\treturn !message.excludeFromContext;
\t\tcase "fileMention":
\t\t\treturn message.files.length > 0;
\t\tcase "branchSummary":
\t\tcase "compactionSummary":
\t\t\treturn true;
\t\tdefault:
\t\t\treturn false;
\t}
}

/**
 * How the hidden cancellation marker at `index` should project now.
 *
 * `project`: a later non-empty conversational turn exists before any assistant,
 * so the receipt is a real turn boundary and not the trailing wire message.
 * `pending`: nothing closes the marker yet; it may become `project` when a
 * later turn is appended, so the array cache must reconvert from here.
 * `blocked`: an assistant follows first, so the extra receipt is unnecessary
 * and can never become necessary.
 */
function cancellationReceiptFollowUp(
\tmessages: AgentMessage[],
\tindex: number,
): "project" | "pending" | "blocked" {
\tfor (let i = index + 1; i < messages.length; i++) {
\t\tconst message = messages[i];
\t\tif (message.role === "assistant") return "blocked";
\t\tif (projectsConversationalTurn(message)) return "project";
\t}
\treturn "pending";
}

/**
 * Synthetic assistant receipt for a restored cancellation. It carries the
 * original aborted turn's api/provider/model and timestamp so it is a valid
 * native assistant message, with zero usage, no output, and no error/tool/
 * thinking fields. Malformed metadata falls through to the stock custom
 * conversion instead of dropping or crashing.
 */
function userInterruptCancelledReceipt(
\tmessage: CustomMessage,
): Message[] | undefined {
\tconst details = isRecord(message.details) ? message.details : undefined;
\tif (
\t\tdetails === undefined ||
\t\ttypeof details.api !== "string" ||
\t\ttypeof details.provider !== "string" ||
\t\ttypeof details.model !== "string" ||
\t\t!Number.isFinite(message.timestamp)
\t) {
\t\treturn undefined;
\t}
\treturn [
\t\t{
\t\t\trole: "assistant",
\t\t\tcontent: [{ type: "text", text: USER_INTERRUPT_CANCELLED_RECEIPT_TEXT }],
\t\t\tapi: details.api as AssistantMessage["api"],
\t\t\tprovider: details.provider as AssistantMessage["provider"],
\t\t\tmodel: details.model,
\t\t\tusage: {
\t\t\t\tinput: 0,
\t\t\t\toutput: 0,
\t\t\t\tcacheRead: 0,
\t\t\t\tcacheWrite: 0,
\t\t\t\ttotalTokens: 0,
\t\t\t\tcost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
\t\t\t},
\t\t\tstopReason: "stop",
\t\t\ttimestamp: message.timestamp,
\t\t},
\t];
}

"""
SOURCE_MESSAGES_HELPER = SOURCE_MESSAGES_HELPER.replace(
    "__CANCELLATION_MESSAGE_LITERAL__", CANCELLATION_MESSAGE_LITERAL
).replace("__CANCELLATION_RECEIPT_LITERAL__", CANCELLATION_RECEIPT_TEXT_LITERAL)

SOURCE_MESSAGES_CUSTOM_ANCHOR = (
    '\t\tcase "custom": {\n\t\t\tif (!isCustomMessageContent(m.content)) return [];'
)
SOURCE_MESSAGES_CUSTOM_REPLACEMENT = (
    SOURCE_MESSAGES_CUSTOM_ANCHOR
    + "\n"
    "\t\t\tif (m.customType === USER_INTERRUPT_CANCELLED_MESSAGE_TYPE) {\n"
    "\t\t\t\t// The marker stays hidden in agent state; only a rebuilt provider\n"
    "\t\t\t\t// request sees the receipt, and only when a later conversational\n"
    "\t\t\t\t// turn follows it. Otherwise the receipt would be the trailing\n"
    "\t\t\t\t// assistant turn, which providers extend with a Continue pad.\n"
    "\t\t\t\tif (!cancellationReceipt) return [];\n"
    "\t\t\t\tconst receipt = userInterruptCancelledReceipt(m);\n"
    "\t\t\t\tif (receipt !== undefined) return receipt;\n"
    "\t\t\t}"
)

SOURCE_MESSAGES_MEMO_ANCHOR = (
    "interface ConvertMemoEntry {\n"
    "\tinterruptedNext: boolean;\n"
    "\tfragment: Message[];\n"
    "}"
)
SOURCE_MESSAGES_MEMO_REPLACEMENT = (
    "interface ConvertMemoEntry {\n"
    "\tinterruptedNext: boolean;\n"
    "\t/** True only when the cancellation marker projected an assistant receipt. */\n"
    "\tcancellationReceipt: boolean;\n"
    "\tfragment: Message[];\n"
    "}"
)

SOURCE_MESSAGES_CACHED_ANCHOR = """function convertOneCached(m: AgentMessage, interruptedNext: boolean): Message[] {
\tconst cached = convertCache.get(m);
\tif (cached !== undefined && cached.interruptedNext === interruptedNext) return cached.fragment;
\tconst fragment = convertOne(m, interruptedNext);
\tfor (const message of fragment) copyPerCallContextMessage(message, m);
\tconvertCache.set(m, { interruptedNext, fragment });
\treturn fragment;
}"""
SOURCE_MESSAGES_CACHED_REPLACEMENT = """function convertOneCached(
\tm: AgentMessage,
\tinterruptedNext: boolean,
\tcancellationReceipt: boolean,
): Message[] {
\tconst cached = convertCache.get(m);
\tif (
\t\tcached !== undefined &&
\t\tcached.interruptedNext === interruptedNext &&
\t\tcached.cancellationReceipt === cancellationReceipt
\t) {
\t\treturn cached.fragment;
\t}
\tconst fragment = convertOne(m, interruptedNext, cancellationReceipt);
\tfor (const message of fragment) copyPerCallContextMessage(message, m);
\tconvertCache.set(m, { interruptedNext, cancellationReceipt, fragment });
\treturn fragment;
}"""

SOURCE_MESSAGES_ARRAY_MEMO_ANCHOR = (
    "interface ConvertArrayMemo {\n"
    "\tgeneration: number;\n"
    "\tlength: number;\n"
    "\toutput: Message[];\n"
    "\ttail: AgentMessage | undefined;\n"
    "\tprefixOutputLen: number;\n"
    "}"
)
SOURCE_MESSAGES_ARRAY_MEMO_REPLACEMENT = (
    "interface ConvertArrayMemo {\n"
    "\tgeneration: number;\n"
    "\tlength: number;\n"
    "\toutput: Message[];\n"
    "\ttail: AgentMessage | undefined;\n"
    "\tprefixOutputLen: number;\n"
    "\t/** First cancellation marker whose projection is still pending a follow-up. */\n"
    "\tpendingCancellationIndex?: number;\n"
    "\t/** Output length before that marker, so growth reconverts from it. */\n"
    "\tpendingCancellationPrefixLen?: number;\n"
    "}"
)

SOURCE_MESSAGES_GROWTH_ANCHOR = """\tif (
\t\tsameGeneration &&
\t\tlen > memo.length &&
\t\tmemo.length > 0 &&
\t\tmessages[memo.length - 1] === memo.tail &&
\t\tmemo.prefixOutputLen <= memo.output.length
\t) {
\t\tout = memo.output.slice(0, memo.prefixOutputLen);
\t\tstart = memo.length - 1;
\t} else {
\t\tout = [];
\t\tstart = 0;
\t}"""
SOURCE_MESSAGES_GROWTH_REPLACEMENT = """\tif (
\t\tsameGeneration &&
\t\tlen > memo.length &&
\t\tmemo.length > 0 &&
\t\tmessages[memo.length - 1] === memo.tail &&
\t\tmemo.prefixOutputLen <= memo.output.length
\t) {
\t\tconst pendingIndex = memo.pendingCancellationIndex;
\t\tconst pendingPrefixLen = memo.pendingCancellationPrefixLen;
\t\tif (
\t\t\tpendingIndex !== undefined &&
\t\t\tpendingPrefixLen !== undefined &&
\t\t\tpendingIndex < memo.length &&
\t\t\tpendingPrefixLen <= memo.output.length
\t\t) {
\t\t\t// The marker was omitted because no conversational turn followed it.
\t\t\t// A growth with only filtered/empty messages keeps it pending, while a
\t\t\t// later real turn makes it project, so reconvert from the marker.
\t\t\tout = memo.output.slice(0, pendingPrefixLen);
\t\t\tstart = pendingIndex;
\t\t} else {
\t\t\tout = memo.output.slice(0, memo.prefixOutputLen);
\t\t\tstart = memo.length - 1;
\t\t}
\t} else {
\t\tout = [];
\t\tstart = 0;
\t}"""

SOURCE_MESSAGES_LOOP_ANCHOR = """\tlet prefixOutputLen = 0;
\tfor (let i = start; i < len; i++) {
\t\tif (i === len - 1) prefixOutputLen = out.length;
\t\tconst m = messages[i];
\t\tconst interruptedNext = m.role === "assistant" && followedByInterruptedThinking(messages, i);
\t\tconst fragment = convertOneCached(m, interruptedNext);
\t\tfor (const msg of fragment) out.push(msg);
\t}"""
SOURCE_MESSAGES_LOOP_REPLACEMENT = """\tlet prefixOutputLen = 0;
\tlet pendingCancellationIndex: number | undefined;
\tlet pendingCancellationPrefixLen: number | undefined;
\tfor (let i = start; i < len; i++) {
\t\tif (i === len - 1) prefixOutputLen = out.length;
\t\tconst m = messages[i];
\t\tconst interruptedNext = m.role === "assistant" && followedByInterruptedThinking(messages, i);
\t\tlet cancellationReceipt = false;
\t\tif (m.role === "custom" && m.customType === USER_INTERRUPT_CANCELLED_MESSAGE_TYPE) {
\t\t\tconst followUp = cancellationReceiptFollowUp(messages, i);
\t\t\tcancellationReceipt = followUp === "project";
\t\t\tif (followUp === "pending" && pendingCancellationIndex === undefined) {
\t\t\t\tpendingCancellationIndex = i;
\t\t\t\tpendingCancellationPrefixLen = out.length;
\t\t\t}
\t\t}
\t\tconst fragment = convertOneCached(m, interruptedNext, cancellationReceipt);
\t\tfor (const msg of fragment) out.push(msg);
\t}"""

SOURCE_MESSAGES_STORE_ANCHOR = """\tconvertArrayCache.set(messages, {
\t\tgeneration: convertGeneration,
\t\tlength: len,
\t\toutput: out,
\t\ttail,
\t\tprefixOutputLen,
\t});"""
SOURCE_MESSAGES_STORE_REPLACEMENT = """\tconvertArrayCache.set(messages, {
\t\tgeneration: convertGeneration,
\t\tlength: len,
\t\toutput: out,
\t\ttail,
\t\tprefixOutputLen,
\t\tpendingCancellationIndex,
\t\tpendingCancellationPrefixLen,
\t});"""


# dist/cli.js -- the bundled form of the same loops. The bundle is upstream's
# official artifact; these are its minified bindings:
#   wO = buildSessionContext, gR = createCustomMessage,
#   kM = isUserInterruptAbort, u6 = isUserAuthoredMessage,
#   AQs = retryableAssistantTurnEnd, Ybr = toolReplayStart,
#   #fe = #stripForToolReplay, i6 = "interrupted-thinking".
BUNDLE_SPLICE_ANCHOR = (
    "if(R.splice(_,1),N.size>0)for(let q=R.length-1;q>=_;q--){"
)
BUNDLE_SPLICE_REPLACEMENT = (
    'if(kM(F)&&F.stopReason==="aborted"&&F.content.length===0'
    "&&F.requestControls===void 0"
    "&&R[_-1]&&u6(R[_-1])"
    '&&(!R[_+1]||R[_+1].role!=="assistant")){'
    "R[_]=gR("
    + CANCELLATION_MESSAGE_LITERAL
    + ","
    + CANCELLATION_TEXT_LITERAL
    + ',!1,{api:F.api,provider:F.provider,model:F.model},new Date(F.timestamp).toISOString(),"agent")'
    "}else{R.splice(_,1)}"
    "if(N.size>0)for(let q=R.length-1;q>=_;q--){"
)
BUNDLE_RETRY_ANCHOR = (
    "else{let s=this.#e.sessionManager.buildSessionContext({transcript:!0}).messages;"
    "if(AQs(s)===void 0)return!1;let n=Ybr(e);"
    "if(n!==void 0)await this.#fe(e,n)}"
)
BUNDLE_RETRY_REPLACEMENT = (
    "else{let s=this.#e.sessionManager.buildSessionContext({transcript:!0}).messages;"
    "if(AQs(s)===void 0)return!1;let n=Ybr(e);"
    "if(n!==void 0)await this.#fe(e,n);"
    "else{let o=e[e.length-1];o?.role===\"custom\"&&"
    "o.customType==="
    + CANCELLATION_MESSAGE_LITERAL
    + "&&this.#e.agent.replaceMessages(e.slice(0,-1))}}"
)

# dist/cli.js -- Fh = convertToLlm, c0a = convertOneCached, p0a = convertOne,
# Xvs = per-message conversion cache, eEs = array memo, bO =
# isCustomMessageContent. The bundle must mirror the source cache behavior: a
# marker's projection depends on messages after it, so the fragment cache keys
# on that flag and the array memo remembers the first still-pending marker.
BUNDLE_CONVERT_CUSTOM_ANCHOR = 'case"custom":{if(!bO(e.content))return[];'
BUNDLE_CONVERT_ONE_ANCHOR = (
    'function p0a(e,t){switch(e.role){case"bashExecution":'
)
BUNDLE_CONVERT_ONE_REPLACEMENT = (
    'function p0a(e,t,flag){switch(e.role){case"bashExecution":'
)
BUNDLE_CONVERT_CUSTOM_REPLACEMENT = (
    BUNDLE_CONVERT_CUSTOM_ANCHOR
    + 'if(e.customType==="turn-cancelled"){if(!flag)return[];let d=e.details;'
    'if(d&&typeof d.api==="string"&&typeof d.provider==="string"'
    '&&typeof d.model==="string"&&Number.isFinite(e.timestamp))return[{role:"assistant",'
    'content:[{type:"text",text:'
    + CANCELLATION_RECEIPT_TEXT_LITERAL
    + '}],api:d.api,provider:d.provider,model:d.model,'
    'usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,'
    'cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},'
    'stopReason:"stop",timestamp:e.timestamp}]}'
)

BUNDLE_CONVERT_HELPER = (
    "function __ompCancelFollow(e,t){for(let s=t+1;s<e.length;s++){"
    "let n=e[s],o=n.content;"
    'if(n.role==="assistant")return 2;'
    'if(n.role==="user"||n.role==="developer"'
    '||((n.role==="custom"||n.role==="hookMessage")&&bO(o))){'
    'if(typeof o==="string"?o.trim().length>0:Array.isArray(o)&&'
    "o.some((a)=>a&&(a.type===\"image\"||"
    '(a.type==="text"&&typeof a.text==="string"&&a.text.trim().length>0))))return 1'
    '}else if((n.role==="bashExecution"||n.role==="pythonExecution")'
    "&&!n.excludeFromContext)return 1;"
    'else if(n.role==="fileMention"&&n.files.length>0)return 1;'
    'else if(n.role==="branchSummary"||n.role==="compactionSummary")return 1'
    "}return 0}"
)
BUNDLE_CONVERT_CACHED_ANCHOR = (
    "function c0a(e,t){let s=Xvs.get(e);if(s!==void 0&&s.interruptedNext===t)"
    "return s.fragment;let n=p0a(e,t);for(let o of n)DP(o,e);"
    "return Xvs.set(e,{interruptedNext:t,fragment:n}),n}"
)
BUNDLE_CONVERT_CACHED_REPLACEMENT = (
    BUNDLE_CONVERT_HELPER
    + "function c0a(e,t,flag){let n=Xvs.get(e);"
    "if(n!==void 0&&n.interruptedNext===t&&n.cancellationReceipt===flag)"
    "return n.fragment;let o=p0a(e,t,flag);for(let r of o)DP(r,e);"
    "return Xvs.set(e,{interruptedNext:t,cancellationReceipt:flag,fragment:o}),o}"
)
BUNDLE_CONVERT_GROWTH_ANCHOR = (
    "let r,i;if(n&&t>s.length&&s.length>0&&e[s.length-1]===s.tail"
    "&&s.prefixOutputLen<=s.output.length)r=s.output.slice(0,s.prefixOutputLen),"
    "i=s.length-1;else r=[],i=0;let a=0;"
)
BUNDLE_CONVERT_GROWTH_REPLACEMENT = (
    "let r,i;if(n&&t>s.length&&s.length>0&&e[s.length-1]===s.tail"
    "&&s.prefixOutputLen<=s.output.length){"
    "let q=s.pendingCancellationIndex,z=s.pendingCancellationPrefixLen;"
    "if(q!==void 0&&z!==void 0&&q<s.length&&z<=s.output.length)"
    "r=s.output.slice(0,z),i=q;"
    "else r=s.output.slice(0,s.prefixOutputLen),i=s.length-1"
    "}else r=[],i=0;let a=0,pc=-1,pcl=0;"
)
BUNDLE_CONVERT_LOOP_ANCHOR = (
    'let u=e[l],p=u.role==="assistant"&&t0a(e,l),c=c0a(u,p);'
    "for(let d of c)r.push(d)"
)
BUNDLE_CONVERT_LOOP_REPLACEMENT = (
    'let u=e[l],p=u.role==="assistant"&&t0a(e,l),'
    'q=u.role==="custom"&&u.customType==="turn-cancelled"'
    "?__ompCancelFollow(e,l):2;"
    "if(q===0&&pc<0)pc=l,pcl=r.length;"
    "let c=c0a(u,p,q===1);for(let d of c)r.push(d)"
)
BUNDLE_CONVERT_STORE_ANCHOR = (
    "return eEs.set(e,{generation:Zvs,length:t,output:r,tail:o,"
    "prefixOutputLen:a}),r"
)
BUNDLE_CONVERT_STORE_REPLACEMENT = (
    "return eEs.set(e,{generation:Zvs,length:t,output:r,tail:o,"
    "prefixOutputLen:a,pendingCancellationIndex:pc<0?void 0:pc,"
    "pendingCancellationPrefixLen:pc<0?void 0:pcl}),r"
)

SOURCE_FILE = "src/session/session-context.ts"
SOURCE_RETRY_FILE = "src/session/turn-recovery.ts"
SOURCE_MESSAGES_FILE = "src/session/messages.ts"
BUNDLE_FILE = "dist/cli.js"


class PatchError(RuntimeError):
    pass


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _replace_once(text: str, old: str, new: str, *, label: str, path: str) -> str:
    count = text.count(old)
    if count != 1:
        raise PatchError(
            f"{path}: expected exactly one {label} anchor, found {count}; "
            "the package is not the pinned OMP build"
        )
    return text.replace(old, new)


def _write_atomic(path: Path, text: str) -> None:
    """Replace `path` with `text` through a same-directory temporary file.

    Package installs may hardlink files into a shared cache (Bun does this by
    default on Linux). Writing the original inode in place would mutate that
    cache, so the patched text goes to a new inode and is moved into place with
    `os.replace`, preserving the original permission bits (the CLI must stay
    executable).
    """
    mode = stat.S_IMODE(path.stat().st_mode)
    handle, temp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    temp_path = Path(temp_name)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(text)
        os.chmod(temp_path, mode)
        os.replace(temp_path, path)
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise


def patch_package(
    package_root: Path,
    *,
    expected_version: str = SUPPORTED_VERSION,
    official_sha256: dict[str, str] | None = OFFICIAL_SHA256,
) -> None:
    """Patch the pinned OMP package in place.

    The container build passes the global package it installed in the same
    layer; other callers pass a disposable private copy. Raises PatchError
    without writing when the package identity, version, hashes, anchors, or
    patch state do not match, or when the package root or a patched file is a
    symlink (patching through one could mutate a shared global install or
    cache).
    """
    package_root = Path(package_root)
    manifest_path = package_root / "package.json"
    source_path = package_root / SOURCE_FILE
    recovery_path = package_root / SOURCE_RETRY_FILE
    messages_path = package_root / SOURCE_MESSAGES_FILE
    bundle_path = package_root / BUNDLE_FILE
    if package_root.is_symlink():
        raise PatchError(
            f"{package_root}: refusing to patch a symlinked package root; "
            "dereference links into a private copy"
        )
    for path in (manifest_path, source_path, recovery_path, messages_path, bundle_path):
        if path.is_symlink():
            raise PatchError(
                f"{path}: refusing to patch a symlink; the package copy is not dereferenced"
            )
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise PatchError(f"{manifest_path}: cannot read package manifest: {error}") from error

    if manifest.get("name") != PACKAGE_NAME:
        raise PatchError(
            f"{manifest_path}: expected package {PACKAGE_NAME}, found {manifest.get('name')!r}"
        )
    if manifest.get("version") != expected_version:
        raise PatchError(
            f"{manifest_path}: expected version {expected_version}, "
            f"found {manifest.get('version')!r}"
        )

    if official_sha256:
        for relative, expected in official_sha256.items():
            path = package_root / relative
            actual = _sha256(path)
            if actual != expected:
                raise PatchError(
                    f"{path}: sha256 {actual} does not match the pinned OMP "
                    f"{expected_version} artifact ({expected})"
                )

    source = source_path.read_text(encoding="utf-8")
    recovery = recovery_path.read_text(encoding="utf-8")
    messages = messages_path.read_text(encoding="utf-8")
    bundle = bundle_path.read_text(encoding="utf-8")

    if any(CANCELLATION_MESSAGE_TYPE in text for text in (source, recovery, messages, bundle)):
        raise PatchError(
            f"{package_root}: {CANCELLATION_MESSAGE_TYPE} already present; "
            "the package is already patched"
        )

    source = _replace_once(
        source,
        SOURCE_IMPORT_ANCHOR,
        SOURCE_IMPORT_REPLACEMENT,
        label="session-context import",
        path=SOURCE_FILE,
    )
    source = _replace_once(
        source,
        SOURCE_HELPER_ANCHOR,
        SOURCE_HELPER + SOURCE_HELPER_ANCHOR,
        label="buildSessionContext",
        path=SOURCE_FILE,
    )
    source = _replace_once(
        source,
        SOURCE_SPLICE_ANCHOR,
        SOURCE_SPLICE_REPLACEMENT,
        label="error/abort drop loop",
        path=SOURCE_FILE,
    )
    recovery = _replace_once(
        recovery,
        SOURCE_RETRY_IMPORT_ANCHOR,
        SOURCE_RETRY_IMPORT_REPLACEMENT,
        label="turn-recovery import",
        path=SOURCE_RETRY_FILE,
    )
    recovery = _replace_once(
        recovery,
        SOURCE_RETRY_ANCHOR,
        SOURCE_RETRY_REPLACEMENT,
        label="retry restored-session branch",
        path=SOURCE_RETRY_FILE,
    )
    for old, new, label in (
        (SOURCE_MESSAGES_HELPER_ANCHOR, SOURCE_MESSAGES_HELPER + SOURCE_MESSAGES_HELPER_ANCHOR, "convertOne"),
        (SOURCE_MESSAGES_ONE_ANCHOR, SOURCE_MESSAGES_ONE_REPLACEMENT, "convertOne signature"),
        (SOURCE_MESSAGES_CUSTOM_ANCHOR, SOURCE_MESSAGES_CUSTOM_REPLACEMENT, "custom conversion"),
        (SOURCE_MESSAGES_MEMO_ANCHOR, SOURCE_MESSAGES_MEMO_REPLACEMENT, "per-message cache entry"),
        (SOURCE_MESSAGES_CACHED_ANCHOR, SOURCE_MESSAGES_CACHED_REPLACEMENT, "convertOneCached"),
        (SOURCE_MESSAGES_ARRAY_MEMO_ANCHOR, SOURCE_MESSAGES_ARRAY_MEMO_REPLACEMENT, "array memo"),
        (SOURCE_MESSAGES_GROWTH_ANCHOR, SOURCE_MESSAGES_GROWTH_REPLACEMENT, "array growth path"),
        (SOURCE_MESSAGES_LOOP_ANCHOR, SOURCE_MESSAGES_LOOP_REPLACEMENT, "convertToLlm loop"),
        (SOURCE_MESSAGES_STORE_ANCHOR, SOURCE_MESSAGES_STORE_REPLACEMENT, "array memo store"),
    ):
        messages = _replace_once(
            messages,
            old,
            new,
            label=label,
            path=SOURCE_MESSAGES_FILE,
        )
    bundle = _replace_once(
        bundle,
        BUNDLE_SPLICE_ANCHOR,
        BUNDLE_SPLICE_REPLACEMENT,
        label="bundled error/abort drop loop",
        path=BUNDLE_FILE,
    )
    bundle = _replace_once(
        bundle,
        BUNDLE_RETRY_ANCHOR,
        BUNDLE_RETRY_REPLACEMENT,
        label="bundled retry restored-session branch",
        path=BUNDLE_FILE,
    )
    for old, new, label in (
        (BUNDLE_CONVERT_ONE_ANCHOR, BUNDLE_CONVERT_ONE_REPLACEMENT, "bundled convertOne signature"),
        (BUNDLE_CONVERT_CUSTOM_ANCHOR, BUNDLE_CONVERT_CUSTOM_REPLACEMENT, "bundled custom conversion"),
        (BUNDLE_CONVERT_CACHED_ANCHOR, BUNDLE_CONVERT_CACHED_REPLACEMENT, "bundled cached conversion"),
        (BUNDLE_CONVERT_GROWTH_ANCHOR, BUNDLE_CONVERT_GROWTH_REPLACEMENT, "bundled array growth path"),
        (BUNDLE_CONVERT_LOOP_ANCHOR, BUNDLE_CONVERT_LOOP_REPLACEMENT, "bundled convertToLlm loop"),
        (BUNDLE_CONVERT_STORE_ANCHOR, BUNDLE_CONVERT_STORE_REPLACEMENT, "bundled array memo store"),
    ):
        bundle = _replace_once(
            bundle,
            old,
            new,
            label=label,
            path=BUNDLE_FILE,
        )

    for relative, text, expected in (
        (
            SOURCE_FILE,
            source,
            (
                "USER_INTERRUPT_CANCELLED_MESSAGE_TYPE",
                "isUserInterruptAbort(message)",
                "isUserAuthoredMessage(messages[i - 1])",
            ),
        ),
        (
            SOURCE_RETRY_FILE,
            recovery,
            (
                "USER_INTERRUPT_CANCELLED_MESSAGE_TYPE",
                "replaceMessages(messages.slice(0, -1))",
            ),
        ),
        (
            SOURCE_MESSAGES_FILE,
            messages,
            (
                "USER_INTERRUPT_CANCELLED_MESSAGE_TYPE",
                "cancellationReceiptFollowUp",
                "userInterruptCancelledReceipt",
                "pendingCancellationIndex",
            ),
        ),
        (
            BUNDLE_FILE,
            bundle,
            (
                "kM(F)",
                "u6(R[_-1])",
                CANCELLATION_MESSAGE_TYPE,
                "__ompCancelFollow",
                "pendingCancellationIndex",
            ),
        ),
    ):
        missing = [marker for marker in expected if marker not in text]
        if missing:
            raise PatchError(f"{relative}: patched text is missing {missing}")

    _write_atomic(source_path, source)
    _write_atomic(recovery_path, recovery)
    _write_atomic(messages_path, messages)
    _write_atomic(bundle_path, bundle)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--package-root",
        required=True,
        type=Path,
        help=(
            "Pinned @oh-my-pi/pi-coding-agent 18.8.6 package root to patch "
            "(image-global install or a private copy)"
        ),
    )
    parser.add_argument(
        "--expected-version",
        default=SUPPORTED_VERSION,
        help=f"Required package version (default: {SUPPORTED_VERSION})",
    )
    args = parser.parse_args(argv)

    try:
        patch_package(args.package_root, expected_version=args.expected_version)
    except PatchError as error:
        print(f"omp interrupt-boundary patch: {error}", file=sys.stderr)
        return 1
    print(f"omp interrupt-boundary patch: applied to {args.package_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
