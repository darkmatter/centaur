/**
 * Restoration and history-shape regression for Centaur's OMP 18.8.6
 * interrupted-request context patch.
 *
 * OMP drops error/aborted assistant turns while rebuilding non-transcript model
 * context. For an empty user interrupt that leaves the aborted request looking
 * unanswered, so a restored session follows the next prompt with the old
 * instruction; `convertToLlm` also drops that assistant shape, so keeping the
 * turn alone cannot fix it. The patch replaces exactly that shape with a hidden
 * `turn-cancelled` custom message during the rebuild; the provider projection
 * and cache cases live in `omp_interrupt_boundary_projection.test.ts`.
 *
 * Run both files against a private, patched OMP package copy:
 *
 *   OMP_PACKAGE_ROOT=/path/to/node_modules/@oh-my-pi/pi-coding-agent \
 *     bun test \
 *       services/sandbox/omp_interrupt_boundary.test.ts \
 *       services/sandbox/omp_interrupt_boundary_projection.test.ts
 *
 * Shared native constructors and package imports live in
 * `omp_interrupt_boundary_fixture.ts`. The package's exports map resolves
 * `./session/*` to `src/session/*.ts`; importing those files directly is the
 * public context-conversion entry point.
 */

import { expect, test } from "bun:test";
import {
	BASE_TS,
	CANCELLED_TYPE,
	INTERRUPTED_LABEL,
	RECEIPT_TEXT,
	USER_INTERRUPT_FLAG,
	anthropicWire,
	assistantEntry,
	build,
	convertToLlm,
	customMessageEntry,
	textOf,
	toolResultEntry,
	userEntry,
} from "./omp_interrupt_boundary_fixture";
import type { ContextMessage, Entry } from "./omp_interrupt_boundary_fixture";

test("restored empty user interrupt becomes a cancellation boundary before the next prompt", () => {
	const entries: Entry[] = [
		userEntry("u-old", null, "OLD REQUEST", 1),
		assistantEntry("a-abort", "u-old", 2, {
			errorId: USER_INTERRUPT_FLAG,
			errorMessage: INTERRUPTED_LABEL,
		}),
		userEntry("u-new", "a-abort", "NEW BACKGROUND TASK", 3),
	];
	const before = JSON.stringify(entries);

	const context = build(entries);
	const messages = context.messages;

	expect(messages.map(message => message.role)).toEqual(["user", "custom", "user"]);
	const boundary = messages[1];
	expect(boundary.customType).toBe(CANCELLED_TYPE);
	expect(boundary.display).toBe(false);
	expect(boundary.attribution).toBe("agent");
	expect(boundary.timestamp).toBe(BASE_TS + 2);

	// The boundary sits between the cancelled request and the new prompt, and
	// is the only thing the provider sees in its place. It must be a real
	// assistant turn: a developer/custom note becomes a wire user turn on
	// Anthropic and gets merged with the cancelled request.
	const provider: ContextMessage[] = convertToLlm(messages);
	expect(provider.map(message => message.role)).toEqual(["user", "assistant", "user"]);
	expect(textOf(provider[0]?.content)).toBe("OLD REQUEST");
	const receipt = provider[1];
	expect(textOf(receipt?.content)).toBe(RECEIPT_TEXT);
	expect(receipt?.stopReason).toBe("stop");
	expect(receipt?.api).toBe("anthropic-messages");
	expect(receipt?.provider).toBe("litellm");
	expect(receipt?.model).toBe("test-model");
	expect(receipt?.timestamp).toBe(BASE_TS + 2);
	expect(receipt?.usage).toEqual({
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
	expect(receipt?.requestControls).toBeUndefined();
	expect(receipt?.errorId).toBeUndefined();
	expect(textOf(provider[2]?.content)).toBe("NEW BACKGROUND TASK");

	// Native Anthropic serialization keeps the three turns distinct. A
	// developer note would serialize as a second user turn and Sonnet merges
	// consecutive user turns, erasing the boundary.
	const wire = anthropicWire(provider);
	expect(wire.map(message => message.role)).toEqual(["user", "assistant", "user"]);
	expect(JSON.stringify(wire[1]?.content)).toContain(RECEIPT_TEXT);

	// Native history and the transcript view are unchanged: the marker exists
	// only in the rebuilt model context.
	expect(JSON.stringify(entries)).toBe(before);
	expect(entries).toHaveLength(3);
	const transcript = build(entries, { transcript: true });
	expect(transcript.messages.map(message => message.role)).toEqual([
		"user",
		"assistant",
		"user",
	]);
	expect(
		transcript.messages.some(message => message.customType === CANCELLED_TYPE),
	).toBe(false);
});

test("the legacy user-interrupt label without the structured flag is the same boundary", () => {
	const entries: Entry[] = [
		userEntry("u", null, "OLD", 1),
		assistantEntry("a", "u", 2, { errorMessage: INTERRUPTED_LABEL }),
		userEntry("u2", "a", "NEW", 3),
	];

	const legacy = build(entries);
	expect(legacy.messages.map(message => message.role)).toEqual(["user", "custom", "user"]);
});

test("partial text, tool interrupts, provider errors, and reasonless aborts keep today's behavior", () => {
	const partial: Entry[] = [
		userEntry("u", null, "OLD", 1),
		assistantEntry("a", "u", 2, {
			content: [{ type: "text", text: "partial answer" }],
			errorId: USER_INTERRUPT_FLAG,
		}),
		userEntry("u2", "a", "NEW", 3),
	];
	const partialContext = build(partial);
	expect(partialContext.messages.map(message => message.role)).toEqual(["user", "user"]);
	expect(partialContext.messages.some(message => message.customType === CANCELLED_TYPE)).toBe(
		false,
	);

	const toolInterrupt: Entry[] = [
		userEntry("u", null, "OLD", 1),
		assistantEntry("a", "u", 2, {
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { cmd: "true" } }],
			errorId: USER_INTERRUPT_FLAG,
		}),
		toolResultEntry("tr", "a", "call-1", 3),
		userEntry("u2", "tr", "NEW", 4),
	];
	const tool = build(toolInterrupt);
	expect(tool.messages.map(message => message.role)).toEqual(["user", "user"]);
	expect(tool.messages.some(message => message.customType === CANCELLED_TYPE)).toBe(false);

	const providerError: Entry[] = [
		userEntry("u", null, "OLD", 1),
		assistantEntry("a", "u", 2, { stopReason: "error", errorMessage: "provider rejected" }),
		userEntry("u2", "a", "NEW", 3),
	];
	const errorContext = build(providerError);
	expect(errorContext.messages.map(message => message.role)).toEqual(["user", "user"]);
	expect(errorContext.messages.some(message => message.customType === CANCELLED_TYPE)).toBe(false);

	const reasonlessAbort: Entry[] = [
		userEntry("u", null, "OLD", 1),
		assistantEntry("a", "u", 2),
		userEntry("u2", "a", "NEW", 3),
	];
	const reasonless = build(reasonlessAbort);
	expect(reasonless.messages.map(message => message.role)).toEqual(["user", "user"]);
	expect(reasonless.messages.some(message => message.customType === CANCELLED_TYPE)).toBe(false);
});

test("an empty abort that carries request controls keeps stock behavior", () => {
	const entries: Entry[] = [
		userEntry("u", null, "OLD", 1),
		assistantEntry("a", "u", 2, {
			errorId: USER_INTERRUPT_FLAG,
			requestControls: { toolRemoval: true },
		}),
		userEntry("u2", "a", "NEW", 3),
	];

	const context = build(entries);
	expect(context.messages.map(message => message.role)).toEqual(["user", "user"]);
	expect(context.messages.some(message => message.customType === CANCELLED_TYPE)).toBe(false);
});

test("tool batches interrupted by Esc keep their replayable shape", () => {
	const entries: Entry[] = [
		userEntry("u", null, "RUN THE TOOL", 1),
		assistantEntry("a-tool", "u", 2, {
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { cmd: "true" } }],
			stopReason: "toolUse",
		}),
		toolResultEntry("tr", "a-tool", "call-1", 3),
		assistantEntry("a-abort", "tr", 4, {
			errorId: USER_INTERRUPT_FLAG,
			errorMessage: INTERRUPTED_LABEL,
		}),
	];

	const context = build(entries);
	expect(context.messages.map(message => message.role)).toEqual([
		"user",
		"assistant",
		"toolResult",
	]);
	expect(context.messages.some(message => message.customType === CANCELLED_TYPE)).toBe(false);
	// The failed result still trails the tool-calling assistant; that tail is
	// what an explicit retry replays instead of re-asking the model.
	const anchor = context.messages[1];
	expect(anchor?.role).toBe("assistant");
	expect(anchor?.stopReason).toBe("toolUse");
	const tail = context.messages.at(-1);
	expect(tail?.role).toBe("toolResult");
	expect(tail?.toolCallId).toBe("call-1");
	const provider: ContextMessage[] = convertToLlm(context.messages);
	expect(provider.map(message => message.role)).toEqual(["user", "assistant", "toolResult"]);
});

test("a successful retry leaves its reply without a cancellation note", () => {
	const entries: Entry[] = [
		userEntry("u", null, "QUESTION", 1),
		assistantEntry("a-abort", "u", 2, {
			errorId: USER_INTERRUPT_FLAG,
			errorMessage: INTERRUPTED_LABEL,
		}),
		assistantEntry("a-reply", "a-abort", 3, {
			content: [{ type: "text", text: "ANSWER" }],
			stopReason: "stop",
		}),
	];

	const context = build(entries);
	expect(context.messages.map(message => message.role)).toEqual(["user", "assistant"]);
	expect(context.messages.some(message => message.customType === CANCELLED_TYPE)).toBe(false);
	const provider: ContextMessage[] = convertToLlm(context.messages);
	expect(provider.map(message => message.role)).toEqual(["user", "assistant"]);
	expect(textOf(provider[1]?.content)).toBe("ANSWER");
});

test("ordinary replies stay assistant turns and the interrupted-thinking pair is untouched", () => {
	const reply: Entry[] = [
		userEntry("u", null, "QUESTION", 1),
		assistantEntry("a", "u", 2, {
			content: [{ type: "text", text: "ANSWER" }],
			stopReason: "stop",
		}),
	];
	const replyContext = build(reply);
	expect(replyContext.messages.map(message => message.role)).toEqual(["user", "assistant"]);
	expect(replyContext.messages.some(message => message.customType === CANCELLED_TYPE)).toBe(false);
	const replyProvider: ContextMessage[] = convertToLlm(replyContext.messages);
	expect(replyProvider.map(message => message.role)).toEqual(["user", "assistant"]);

	const interruptedThinking: Entry[] = [
		userEntry("u", null, "OLD", 1),
		assistantEntry("a", "u", 2, { errorId: USER_INTERRUPT_FLAG }),
		customMessageEntry("it", "a", "interrupted-thinking", "Demoted reasoning", 3),
		userEntry("u2", "it", "NEW", 4),
	];
	const thinkingContext = build(interruptedThinking);
	expect(thinkingContext.messages.map(message => message.role)).toEqual([
		"user",
		"assistant",
		"custom",
		"user",
	]);
	expect(thinkingContext.messages.some(message => message.customType === CANCELLED_TYPE)).toBe(
		false,
	);
	const thinkingProvider: ContextMessage[] = convertToLlm(thinkingContext.messages);
	expect(
		thinkingProvider.some(message => textOf(message.content).includes(CANCELLED_TYPE)),
	).toBe(false);
});
