/**
 * Projection, cache, and provider-wire regression for Centaur's OMP 18.8.6
 * interrupted-request context patch.
 *
 * The hidden `turn-cancelled` marker becomes a synthetic assistant receipt only
 * when a later non-empty conversational turn follows it before another
 * assistant. These tests exercise that projection through the public
 * `convertToLlm` export, its per-message and array caches, and the native
 * Anthropic wire transform for Sonnet 5.
 *
 * Run both regression files against a private, patched OMP package copy:
 *
 *   OMP_PACKAGE_ROOT=/path/to/node_modules/@oh-my-pi/pi-coding-agent \
 *     bun test \
 *       services/sandbox/omp_interrupt_boundary.test.ts \
 *       services/sandbox/omp_interrupt_boundary_projection.test.ts
 */

import { expect, test } from "bun:test";
import {
	BASE_TS,
	CANCELLED_TYPE,
	RECEIPT_TEXT,
	USER_INTERRUPT_FLAG,
	anthropicWire,
	assistantEntry,
	build,
	cancellationMarker,
	convertToLlm,
	textOf,
	userEntry,
	userMessage,
} from "./omp_interrupt_boundary_fixture";
import type { ContextMessage, Entry } from "./omp_interrupt_boundary_fixture";

test("repeated interrupts in one turn collapse to a single boundary", () => {
	const entries: Entry[] = [
		userEntry("u", null, "OLD", 1),
		assistantEntry("a1", "u", 2, { errorId: USER_INTERRUPT_FLAG }),
		assistantEntry("a2", "a1", 3, { errorId: USER_INTERRUPT_FLAG }),
	];

	const context = build(entries);
	expect(context.messages.map(message => message.role)).toEqual(["user", "custom"]);
	expect(
		context.messages.filter(message => message.customType === CANCELLED_TYPE),
	).toHaveLength(1);

	// Nothing follows the marker yet, so no receipt is emitted: an assistant
	// would be the trailing wire turn and providers would append a Continue
	// pad. The existing request stays exactly as it was.
	const provider: ContextMessage[] = convertToLlm(context.messages);
	expect(provider.map(message => message.role)).toEqual(["user"]);
	expect(anthropicWire(provider).map(message => message.role)).toEqual(["user"]);

	// A later real prompt on the same array makes the boundary project. The
	// growth shortcut must reconvert from the pending marker, not from the
	// array's old tail.
	const messages = context.messages;
	messages.push(userMessage("NEXT", BASE_TS + 4));
	const reopened: ContextMessage[] = convertToLlm(messages);
	expect(reopened.map(message => message.role)).toEqual(["user", "assistant", "user"]);
	expect(textOf(reopened[1]?.content)).toBe(RECEIPT_TEXT);
	expect(textOf(reopened[2]?.content)).toBe("NEXT");
	expect(anthropicWire(reopened).map(message => message.role)).toEqual([
		"user",
		"assistant",
		"user",
	]);

	// Exact-repeat conversion is stable, and a fresh array rebuild agrees.
	expect(convertToLlm(messages)).toBe(reopened);
	const rebuilt: ContextMessage[] = convertToLlm([...messages]);
	expect(rebuilt.map(message => message.role)).toEqual(["user", "assistant", "user"]);
	expect(textOf(rebuilt[1]?.content)).toBe(RECEIPT_TEXT);
});

test("a pending boundary survives filtered messages and projects once a real turn arrives", () => {
	const emptyCustom: ContextMessage = {
		role: "custom",
		customType: "other",
		content: "",
		display: false,
		attribution: "agent",
		timestamp: BASE_TS + 3,
	};
	// Hook content must pass the same custom-content guard as the bundle: a
	// malformed object is filtered and cannot close the marker.
	const malformedHook: ContextMessage = {
		role: "hookMessage",
		customType: "other",
		content: { type: "text", text: "MALFORMED HOOK" },
		display: false,
		attribution: "agent",
		timestamp: BASE_TS + 4,
	};
	const messages: ContextMessage[] = [
		userMessage("OLD", BASE_TS + 1),
		cancellationMarker(),
		emptyCustom,
		malformedHook,
	];

	// The empty custom still appears in the public conversion (as an empty
	// developer message) but contributes nothing on the native wire; the
	// malformed hook contributes nothing either. No receipt may be emitted yet.
	const initial: ContextMessage[] = convertToLlm(messages);
	expect(initial.map(message => message.role)).toEqual(["user", "developer"]);
	expect(initial.some(message => message.role === "assistant")).toBe(false);
	expect(anthropicWire(initial).map(message => message.role)).toEqual(["user"]);
	expect(convertToLlm(messages)).toBe(initial);

	messages.push(userMessage("NEXT", BASE_TS + 5));
	const reopened: ContextMessage[] = convertToLlm(messages);
	expect(reopened.map(message => message.role)).toEqual([
		"user",
		"assistant",
		"developer",
		"user",
	]);
	expect(textOf(reopened[1]?.content)).toBe(RECEIPT_TEXT);
	expect(anthropicWire(reopened).map(message => message.role)).toEqual([
		"user",
		"assistant",
		"user",
	]);
});

test("an assistant after the marker never projects a receipt", () => {
	const messages: ContextMessage[] = [
		userMessage("OLD", BASE_TS + 1),
		cancellationMarker(),
		{
			role: "assistant",
			content: [{ type: "text", text: "ANSWER" }],
			stopReason: "stop",
			api: "anthropic-messages",
			provider: "litellm",
			model: "test-model",
			timestamp: BASE_TS + 3,
		},
		userMessage("NEXT", BASE_TS + 4),
	];

	const provider: ContextMessage[] = convertToLlm(messages);
	expect(provider.map(message => message.role)).toEqual(["user", "assistant", "user"]);
	expect(textOf(provider[1]?.content)).toBe("ANSWER");
	expect(JSON.stringify(provider)).not.toContain(RECEIPT_TEXT);
	const wire = anthropicWire(provider);
	expect(wire.map(message => message.role)).toEqual(["user", "assistant", "user"]);
	expect(JSON.stringify(wire)).not.toContain("Continue.");
	expect(JSON.stringify(wire)).not.toContain(RECEIPT_TEXT);
});

test("malformed cancellation metadata falls back to the stock custom conversion", () => {
	const messages: ContextMessage[] = [
		userMessage("OLD", BASE_TS + 1),
		cancellationMarker({}),
		userMessage("NEXT", BASE_TS + 3),
	];

	const provider: ContextMessage[] = convertToLlm(messages);
	expect(provider.map(message => message.role)).toEqual(["user", "developer", "user"]);
	expect(textOf(provider[1]?.content)).toBe("The user interrupted the previous request.");
	expect(JSON.stringify(provider)).not.toContain(RECEIPT_TEXT);

	const withoutTimestamp: ContextMessage[] = [
		userMessage("OLD", BASE_TS + 1),
		{ ...cancellationMarker(), timestamp: Number.NaN },
		userMessage("NEXT", BASE_TS + 3),
	];
	const fallback = convertToLlm(withoutTimestamp);
	expect(fallback.map(message => message.role)).toEqual(["user", "developer", "user"]);
	expect(JSON.stringify(fallback)).not.toContain(RECEIPT_TEXT);
});

test("foreign custom messages keep their stock developer conversion", () => {
	const messages: ContextMessage[] = [
		userMessage("OLD", BASE_TS + 1),
		{
			role: "custom",
			customType: "foreign-note",
			content: "FOREIGN NOTE",
			display: false,
			attribution: "agent",
			timestamp: BASE_TS + 2,
		},
		userMessage("NEXT", BASE_TS + 3),
	];

	const provider: ContextMessage[] = convertToLlm(messages);
	expect(provider.map(message => message.role)).toEqual(["user", "developer", "user"]);
	expect(textOf(provider[1]?.content)).toBe("FOREIGN NOTE");
});
