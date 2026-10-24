/**
 * Shared native fixture for the OMP 18.8.6 interrupted-request regression.
 *
 * The package root is supplied at runtime, so the public `buildSessionContext`,
 * `convertToLlm`, and Anthropic wire exports are loaded dynamically from the
 * private patched copy. Constructors and local interfaces here stay honest
 * about the message shapes they exercise; they do not reimplement conversion.
 */

import { isAbsolute, join } from "node:path";

const packageRoot = process.env.OMP_PACKAGE_ROOT;
if (!packageRoot || !isAbsolute(packageRoot)) {
	throw new Error(
		"OMP_PACKAGE_ROOT must be an absolute path to a patched @oh-my-pi/pi-coding-agent 18.8.6 package",
	);
}

export type Entry = {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	message?: Record<string, unknown>;
	customType?: string;
	content?: unknown;
	details?: unknown;
	display?: boolean;
	attribution?: string;
};

export type ContextMessage = {
	role: string;
	content?: unknown;
	customType?: string;
	details?: unknown;
	display?: boolean;
	timestamp?: number;
	attribution?: string;
	stopReason?: string;
	toolCallId?: string;
	api?: string;
	provider?: string;
	model?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: Record<string, number>;
	};
	requestControls?: unknown;
	errorId?: unknown;
};

type TextBlock = { type: "text"; text: string };

export const BASE_TS = 1_700_000_000_000;
/** AIError.Flag.UserInterrupt in @oh-my-pi/pi-ai 18.8.6. */
export const USER_INTERRUPT_FLAG = 0x04_00_00_00;
export const INTERRUPTED_LABEL = "Interrupted by user";
export const CANCELLED_TYPE = "turn-cancelled";
export const RECEIPT_TEXT =
	"The previous request was cancelled by the user before any output was produced.";

const { buildSessionContext } = await import(join(packageRoot, "src/session/session-context.ts"));
const { convertToLlm: nativeConvertToLlm } = await import(
	join(packageRoot, "src/session/messages.ts")
);
const { convertAnthropicMessages: nativeConvertAnthropicMessages } = await import(
	join(packageRoot, "..", "pi-ai", "src/providers/anthropic.ts")
);
const { getBundledModel } = await import(join(packageRoot, "..", "pi-catalog", "src/models.ts"));

/** The production Sonnet generation, used only for its native offline wire transform. */
const sonnet5 = getBundledModel("anthropic", "claude-sonnet-5");
if (!sonnet5) throw new Error("bundled claude-sonnet-5 model is unavailable");

const usage = {
	input: 1,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function userEntry(
	id: string,
	parentId: string | null,
	text: string,
	offset: number,
): Entry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(BASE_TS + offset).toISOString(),
		message: {
			role: "user",
			content: [{ type: "text", text }],
			attribution: "user",
			timestamp: BASE_TS + offset,
		},
	};
}

export function assistantEntry(
	id: string,
	parentId: string | null,
	offset: number,
	options: {
		content?: unknown[];
		stopReason?: string;
		errorId?: number;
		errorMessage?: string;
		requestControls?: unknown;
	} = {},
): Entry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(BASE_TS + offset).toISOString(),
		message: {
			role: "assistant",
			content: options.content ?? [],
			api: "anthropic-messages",
			provider: "litellm",
			model: "test-model",
			usage,
			stopReason: options.stopReason ?? "aborted",
			...(options.errorId === undefined ? {} : { errorId: options.errorId }),
			...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
			...(options.requestControls === undefined
				? {}
				: { requestControls: options.requestControls }),
			timestamp: BASE_TS + offset,
		},
	};
}

export function toolResultEntry(
	id: string,
	parentId: string,
	toolCallId: string,
	offset: number,
): Entry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(BASE_TS + offset).toISOString(),
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "bash",
			content: [{ type: "text", text: "aborted" }],
			isError: true,
			timestamp: BASE_TS + offset,
		},
	};
}

export function customMessageEntry(
	id: string,
	parentId: string,
	customType: string,
	content: string,
	offset: number,
): Entry {
	return {
		type: "custom_message",
		id,
		parentId,
		timestamp: new Date(BASE_TS + offset).toISOString(),
		customType,
		content,
		display: false,
		attribution: "agent",
	};
}

export function build(
	entries: Entry[],
	options: Record<string, unknown> = {},
): { messages: ContextMessage[] } {
	return buildSessionContext(entries, entries.at(-1)?.id ?? null, undefined, options);
}

export function isTextBlock(value: unknown): value is TextBlock {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "text" &&
		"text" in value &&
		typeof value.text === "string"
	);
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter(isTextBlock).map(block => block.text).join("\n");
}

export function userMessage(text: string, timestamp: number): ContextMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		attribution: "user",
		timestamp,
	};
}

export function cancellationMarker(
	details: Record<string, unknown> = {
		api: "anthropic-messages",
		provider: "litellm",
		model: "test-model",
	},
	timestamp = BASE_TS + 2,
): ContextMessage {
	return {
		role: "custom",
		customType: CANCELLED_TYPE,
		content: "The user interrupted the previous request.",
		display: false,
		attribution: "agent",
		details,
		timestamp,
	};
}

export const convertToLlm: (messages: ContextMessage[]) => ContextMessage[] =
	nativeConvertToLlm;

/** Native Anthropic wire conversion for Sonnet 5, run entirely offline. */
export function anthropicWire(messages: ContextMessage[]): { role: string; content: unknown }[] {
	return nativeConvertAnthropicMessages(messages, sonnet5, false);
}
