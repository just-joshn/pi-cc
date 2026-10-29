/**
 * Claude Code's tool surface, projected at the model boundary.
 *
 * pi's tools keep their own names, input fields and results everywhere inside the process: the
 * registry, tool-call and tool-result events, extension hooks and overrides, compaction, the
 * system prompt's tool detection, and the session transcript. This module is the one place that
 * knows Claude Code's spelling of those tools, so that is also the one place a Claude Code name,
 * input field or result text exists:
 *
 * - {@link projectDeclarations} renames the declared tools the model sees and replaces their
 *   schemas with Claude Code's.
 * - {@link projectToolCall} turns a tool call the model emitted into the pi tool and arguments
 *   that execute it, or into the validation error Claude Code answers it with.
 * - {@link projectToolResult} turns a pi tool result into the text Claude Code's model reads.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, Message, Tool } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { type TSchema, Type } from "typebox";

/** The declaration Claude Code keeps in every list to hold deferred loading open (measured). */
export const CC_PLACEHOLDER_NAME = "DeferredToolPlaceholder";

const placeholderDescription = "Reserved placeholder that keeps deferred tool loading active; never call this tool.";

/** The declaration Claude Code keeps in every tool list, second to last. */

/** Claude Code's input schemas, copied field for field from the request bodies it sends. */
const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (optional, no default timeout)" })),
	description: Type.Optional(Type.String({ description: "What the command does, in one short sentence" })),
	run_in_background: Type.Optional(Type.Boolean({ description: "Run the command without waiting for it to finish" })),
	dangerouslyDisableSandbox: Type.Optional(
		Type.Boolean({ description: "Run without the sandbox when the environment provides one" }),
	),
});

const editSchema = Type.Object({
	file_path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	old_string: Type.String({ description: "Exact text to replace, including whitespace and indentation" }),
	new_string: Type.String({ description: "Replacement text" }),
	replace_all: Type.Optional(Type.Boolean({ default: false, description: "Replace every occurrence of old_string" })),
});

const readSchema = Type.Object({
	file_path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER,
			description: "Line number to start reading from, 1-indexed. Default: 1",
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			exclusiveMinimum: 0,
			maximum: Number.MAX_SAFE_INTEGER,
			description: "Maximum number of lines to return",
		}),
	),
	pages: Type.Optional(
		Type.String({
			description:
				'PDF page range such as "1-5". This build cannot render PDF pages, so it is accepted and ignored.',
		}),
	),
	allow_large: Type.Optional(Type.Boolean({ description: "Read a file larger than the default size limit" })),
});

const writeSchema = Type.Object({
	file_path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

const placeholderSchema = Type.Object({});

/**
 * How one covered tool crosses the boundary: the name and schema the model sees, the pi tool that
 * runs, and the input fields in both spellings.
 */
interface CcTool {
	/** pi's registered name. */
	readonly pi: string;
	/** The name Claude Code declares. */
	readonly name: string;
	readonly parameters: TSchema;
	/** Claude Code's input property names, in declaration order. */
	readonly fields: readonly string[];
	/** pi's input property names, so a validation message can be mapped back. */
	readonly piFields: readonly string[];
	/** pi's arguments for one Claude Code call. Throws {@link CcInputError} for input Claude Code rejects. */
	readonly toPi: (args: Record<string, unknown>) => Record<string, unknown>;
}

const CC_TOOLS: readonly CcTool[] = [
	{
		pi: "bash",
		name: "Bash",
		parameters: bashSchema,
		fields: ["command", "timeout", "description", "run_in_background", "dangerouslyDisableSandbox"],
		piFields: ["command", "timeout"],
		toPi: (args) => ({
			command: args.command,
			...(args.timeout === undefined ? {} : { timeout: (args.timeout as number) / 1000 }),
		}),
	},
	{
		pi: "edit",
		name: "Edit",
		parameters: editSchema,
		fields: ["file_path", "old_string", "new_string", "replace_all"],
		piFields: ["path", "edits", "replaceAll"],
		// An empty old_string is Claude Code's file creation, which pi's edit writes verbatim.
		toPi: (args) => ({
			path: args.file_path,
			edits: [{ oldText: args.old_string, newText: args.new_string }],
			replaceAll: args.replace_all === true,
		}),
	},
	{
		pi: "read",
		name: "Read",
		parameters: readSchema,
		fields: ["file_path", "offset", "limit", "pages", "allow_large"],
		piFields: ["path", "offset", "limit", "allowLarge"],
		toPi: (args) => ({
			path: args.file_path,
			...(args.offset === undefined ? {} : { offset: args.offset }),
			...(args.limit === undefined ? {} : { limit: args.limit }),
			...(args.allow_large === undefined ? {} : { allowLarge: args.allow_large }),
		}),
	},
	{
		pi: "write",
		name: "Write",
		parameters: writeSchema,
		fields: ["file_path", "content"],
		piFields: ["path", "content"],
		toPi: (args) => ({ path: args.file_path, content: args.content }),
	},
];

/** Claude Code's answer to a tool call whose input it rejects. */
export class CcInputError extends Error {
	readonly issues: readonly string[];

	constructor(toolName: string, issues: readonly string[]) {
		super(inputValidationText(toolName, issues));
		this.name = "CcInputError";
		this.issues = issues;
	}
}

/** `<tool_use_error>InputValidationError: <Tool> failed due to the following issue(s):` and one line per issue. */
export function inputValidationText(toolName: string, issues: readonly string[]): string {
	const noun = issues.length === 1 ? "issue" : "issues";
	return `<tool_use_error>InputValidationError: ${toolName} failed due to the following ${noun}:\n${issues.join("\n")}</tool_use_error>`;
}

/** The coverage entry for a pi tool name, or undefined when the surface does not cover it. */
function ccTool(piName: string): CcTool | undefined {
	return CC_TOOLS.find((tool) => tool.pi === piName);
}

/** The coverage entry for a name the model used, or undefined when the name is not covered. */
function ccToolByDeclaredName(name: string): CcTool | undefined {
	return CC_TOOLS.find((tool) => tool.name === name);
}

/**
 * The declarations to send: Claude Code's names and schemas for the tools it covers, everything
 * else unchanged, ordered by name as Claude Code orders its own list, with the placeholder
 * second to last.
 */
export function projectDeclarations(tools: readonly Tool[], includePlaceholder: boolean): Tool[] {
	const projected = tools.map((tool) => {
		const covered = ccTool(tool.name);
		if (!covered) return tool;
		return {
			name: covered.name,
			description: tool.description,
			parameters: covered.parameters,
			// Claude Code sends its schemas verbatim and marks no tool strict, so no strict rewrite.
			constrainedSampling: false as const,
			...(tool.deferLoading === true ? { deferLoading: true } : {}),
		};
	});
	if (includePlaceholder && projected.length > 0 && !projected.some((tool) => tool.name === CC_PLACEHOLDER_NAME)) {
		projected.push({
			name: CC_PLACEHOLDER_NAME,
			description: placeholderDescription,
			parameters: placeholderSchema,
			deferLoading: true,
		});
	}
	// Claude Code declares its tools alphabetically and keeps the placeholder second to last.
	const ordered = [...projected].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
	const placeholderIndex = ordered.findIndex((tool) => tool.name === CC_PLACEHOLDER_NAME);
	if (placeholderIndex !== -1 && ordered.length > 1) {
		const [placeholder] = ordered.splice(placeholderIndex, 1);
		ordered.splice(ordered.length - 1, 0, placeholder);
	}
	return ordered;
}

/** One model-issued tool call, as pi will record and run it. */
export interface ProjectedToolCall {
	name: string;
	arguments: Record<string, unknown>;
	/** Claude Code's rejection of this call's input; set instead of arguments when input is invalid. */
	inputError?: string;
}

/**
 * Turn a model-issued call into the pi call that runs it. Unknown names pass through so the loop
 * answers them the way Claude Code does.
 */
export function projectToolCall(call: {
	name: string;
	arguments: unknown;
	argumentsError?: string;
}): ProjectedToolCall {
	const covered = ccToolByDeclaredName(call.name);
	if (!covered) return { name: call.name, arguments: (call.arguments ?? {}) as Record<string, unknown> };
	if (call.argumentsError !== undefined) {
		return { name: covered.pi, arguments: {}, inputError: `<tool_use_error>${call.argumentsError}</tool_use_error>` };
	}
	const args = (call.arguments ?? {}) as Record<string, unknown>;
	const issues = validateInput(covered, args);
	if (issues.length > 0)
		return { name: covered.pi, arguments: {}, inputError: inputValidationText(covered.name, issues) };
	return { name: covered.pi, arguments: covered.toPi(args) };
}

/**
 * Claude Code's input checks for one call: no unknown properties, every required property
 * present, and every value the declared type. A numeric string is accepted for a number field,
 * as Claude Code accepts it; anything else is reported.
 */
function validateInput(tool: CcTool, args: Record<string, unknown>): string[] {
	const issues: string[] = [];
	const schema = tool.parameters as {
		properties?: Record<string, { type?: string | string[] }>;
		required?: string[];
	};
	const properties = schema.properties ?? {};
	for (const key of Object.keys(args)) {
		if (!(key in properties)) issues.push(`An unexpected parameter \`${key}\` was provided`);
	}
	for (const key of schema.required ?? []) {
		if (!(key in args)) issues.push(`The required parameter \`${key}\` is missing`);
	}
	for (const [key, value] of Object.entries(args)) {
		const declared = properties[key]?.type;
		if (declared === undefined || !(key in args) || value === undefined) continue;
		const coerced = coerceToDeclaredType(value, declared);
		if (coerced === undefined) {
			issues.push(
				`The parameter \`${key}\` type is expected as \`${Array.isArray(declared) ? declared.join(" | ") : declared}\` but provided as \`${jsonType(value)}\``,
			);
		}
	}
	// The converted form is what pi runs, so write the coerced numbers back in place.
	for (const [key, value] of Object.entries(args)) {
		const declared = properties[key]?.type;
		if (declared === undefined || value === undefined) continue;
		const coerced = coerceToDeclaredType(value, declared);
		if (coerced !== undefined) args[key] = coerced;
	}
	return issues;
}

/** The value as the declared type, or undefined when Claude Code would report a type error. */
function coerceToDeclaredType(value: unknown, declared: string | string[]): unknown {
	const types = Array.isArray(declared) ? declared : [declared];
	for (const type of types) {
		const coerced = coerceToType(value, type);
		if (coerced !== undefined) return coerced;
	}
	return undefined;
}

function coerceToType(value: unknown, type: string): unknown {
	switch (type) {
		case "string":
			return typeof value === "string" ? value : undefined;
		case "number":
			if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
			if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
			return undefined;
		case "integer":
			if (typeof value === "number") return Number.isInteger(value) ? value : undefined;
			if (typeof value === "string" && value.trim() !== "" && Number.isInteger(Number(value))) return Number(value);
			return undefined;
		case "boolean":
			return typeof value === "boolean" ? value : undefined;
		case "null":
			return value === null ? value : undefined;
		case "array":
			return Array.isArray(value) ? value : undefined;
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
		default:
			return value;
	}
}

function jsonType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}
// ---------------------------------------------------------------------------
// Boundary wiring
// ---------------------------------------------------------------------------

/**
 * pi's tool name for a spelling the operator wrote. Claude Code's names reach pi from the command
 * line (`--tools Read,Bash`), the settings file and extension tool lists, so they are translated
 * where a name becomes part of the active set, never inside the tools themselves.
 */
export function piToolName(name: string): string {
	const modifier = name.startsWith("+") || name.startsWith("-") ? name[0] : "";
	const bare = modifier === "" ? name : name.slice(1);
	return modifier + (ccToolByDeclaredName(bare)?.pi ?? bare);
}

/** {@link piToolName} for a whole list. */
export function piToolNames(names: readonly string[]): string[] {
	return names.map(piToolName);
}

/** One direction of the model boundary: the transcript pi sends, and the messages the model returns. */
export interface CcSurfaceOptions {
	/** Whether the model is offered `DeferredToolPlaceholder`. Default: true. */
	placeholder?: boolean;
}

/**
 * Project the transcript a provider call will send: declared tools become the ones Claude Code
 * declares. The stored transcript is not modified.
 */
export function projectMessagesForModel(messages: readonly Message[], options?: CcSurfaceOptions): Message[] {
	const includePlaceholder = options?.placeholder !== false;
	return messages.map((message) => {
		if (message.role === "system") {
			const toolsAdded = message.toolsAdded;
			if (toolsAdded === undefined) return message;
			const projected = projectDeclarations(toolsAdded, includePlaceholder);
			// A removal names a pi tool; the model knows the tool by its Claude Code name.
			const toolsRemoved = message.toolsRemoved?.map((tool) => ({
				...tool,
				name: ccTool(tool.name)?.name ?? tool.name,
			}));
			return {
				...message,
				toolsAdded: projected,
				...(toolsRemoved === undefined ? {} : { toolsRemoved }),
			};
		}
		return message;
	});
}

/**
 * Project one assistant message the model returned into the pi message the loop records: a tool
 * call that Claude Code named and shaped becomes the pi call that runs it.
 */
export function projectAssistantMessageForPi(message: AssistantMessage): AssistantMessage {
	let changed = false;
	const content = message.content.map((block) => {
		if (block.type !== "toolCall") return block;
		const projected = projectToolCall(block);
		if (projected.name === block.name && projected.inputError === undefined) return block;
		changed = true;
		return {
			...block,
			name: projected.name,
			arguments: projected.arguments,
			...(projected.inputError === undefined ? {} : { argumentsError: projected.inputError }),
		} as typeof block;
	});
	return changed ? { ...message, content } : message;
}

function projectStreamEvent(event: AssistantMessageEvent): AssistantMessageEvent {
	switch (event.type) {
		case "done":
			return { ...event, message: projectAssistantMessageForPi(event.message) };
		case "error":
			return { ...event, error: projectAssistantMessageForPi(event.error) };
		default:
			return { ...event, partial: projectAssistantMessageForPi(event.partial) };
	}
}

/**
 * Wrap a provider stream so the loop only ever sees pi's tool names and arguments, while the
 * provider only ever sees Claude Code's. Every other event passes through untouched.
 */
export function wrapStreamFn(stream: StreamFn): StreamFn {
	return (model, context, options) => {
		const response = stream(model, context, options);
		return response instanceof Promise ? response.then((settled) => projectStream(settled)) : projectStream(response);
	};
}

function projectStream(stream: AssistantMessageEventStream): AssistantMessageEventStream {
	const projected = new AssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of stream) projected.push(projectStreamEvent(event));
			// A stream can finish with end(message) and no done event. Forward that message, or the
			// loop waits forever on result().
			projected.end(projectAssistantMessageForPi(await stream.result()));
		} catch (error) {
			projected.end({
				role: "assistant",
				content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
				stopReason: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
				api: "anthropic-messages",
				provider: "anthropic",
				model: "unknown",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});
		}
	})();
	return projected;
}
