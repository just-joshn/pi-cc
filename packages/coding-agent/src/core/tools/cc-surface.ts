/**
 * Claude Code's tool surface, projected at the model boundary.
 *
 * pi's tools keep their own names, input fields and results everywhere inside the process: the
 * registry, tool-call and tool-result events, extension hooks and overrides, compaction, the
 * system prompt's tool detection, and the session transcript. This module is the one place that
 * owns the conversion between pi's names and the model's names. Stored calls retain the model's
 * original input only for replay; execution and extension hooks still use pi's arguments:
 *
 * - {@link projectDeclarations} renames the declared tools the model sees and replaces their
 *   schemas with Claude Code's.
 * - {@link projectToolCall} turns a tool call the model emitted into the pi tool and arguments
 *   that execute it, or into the validation error Claude Code answers it with. The model's
 *   original call is kept on the block for replay after input coercion and defaults.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	JsonObject,
	Message,
	Model,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { type TSchema, Type } from "typebox";
import { isAgentsReminder, isInjectedReminder } from "../memory/wrapper.ts";
import { CC_READ_MAX_BYTES, CC_READ_MAX_TOKENS } from "./cc-text.ts";
import { editToolSystemPromptContribution } from "./edit.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./truncate.ts";

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
	/** The description sent with {@link parameters}, when pi's own names fields the model does not have. */
	readonly description?: string;
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
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in milliseconds.`,
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
		description:
			"Edit a single file using exact text replacement. old_string must match a unique region of the file exactly, including whitespace and indentation, unless replace_all is set; a failed match is not retried with normalization. An empty old_string creates the file with new_string.",
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
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. A file larger than ${CC_READ_MAX_BYTES / 1024}KB is refused unless allow_large is set. Text output is capped at about ${CC_READ_MAX_TOKENS} tokens; page through a larger file with offset and limit.`,
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
	// An extension registered under a Claude Code name owns that name. pi's tool is not also
	// declared as it, or the model sees two tools with one name and calls land on pi's.
	const owned = new Set(tools.filter((tool) => ccToolByDeclaredName(tool.name)).map((tool) => tool.name));
	const projected = tools.flatMap((tool) => {
		const covered = ccTool(tool.name);
		if (covered && owned.has(covered.name)) return [];
		if (!covered) return [tool];
		return [
			{
				name: covered.name,
				description: covered.description ?? tool.description,
				parameters: covered.parameters,
				// Claude Code sends its schemas verbatim and marks no tool strict, so no strict rewrite.
				constrainedSampling: false as const,
				...(tool.deferLoading === true ? { deferLoading: true } : {}),
			},
		];
	});
	if (includePlaceholder && projected.length > 0 && !projected.some((tool) => tool.name === CC_PLACEHOLDER_NAME)) {
		projected.push({
			name: CC_PLACEHOLDER_NAME,
			description: placeholderDescription,
			parameters: placeholderSchema,
			deferLoading: true,
		});
	}
	// Claude Code sorts its built-in tools, then its MCP tools, each by locale, and splices the
	// placeholder in second to last (analysis/readable/chunk-13f3hezx.js:3510, chunk-r5cyd28m.js:74897).
	// The locale is fixed so the declared order, and with it the cache prefix, does not follow LANG.
	const byLocale = (left: Tool, right: Tool) => left.name.localeCompare(right.name, "en");
	const isMcp = (tool: Tool) => tool.name.startsWith("mcp__");
	const listed = projected.filter((tool) => tool.name !== CC_PLACEHOLDER_NAME);
	const ordered = [...listed.filter((tool) => !isMcp(tool)).sort(byLocale), ...listed.filter(isMcp).sort(byLocale)];
	const placeholder = projected.find((tool) => tool.name === CC_PLACEHOLDER_NAME);
	if (placeholder) ordered.splice(Math.max(ordered.length - 1, 0), 0, placeholder);
	return ordered;
}

/** One model-issued tool call, as pi will record and run it. */
export interface ProjectedToolCall {
	name: string;
	arguments: Record<string, unknown>;
	/** Claude Code's rejection of this call's input; set instead of arguments when input is invalid. */
	inputError?: string;
	/** The call the model issued, coerced, with Claude Code's defaults filled. History replays this. */
	modelCall?: { name: string; arguments: JsonObject };
}

/**
 * Turn a model-issued call into the pi call that runs it. Unknown names pass through so the loop
 * answers them the way Claude Code does.
 */
export function projectToolCall(call: {
	name: string;
	arguments: unknown;
	argumentsError?: string;
	/** pi names currently offered to the model. A covered name absent here is disabled. */
	active?: ReadonlySet<string>;
	/** Registered tools whose name is already a Claude Code name. They own that name. */
	ownedNames?: ReadonlySet<string>;
}): ProjectedToolCall {
	const received = copyArgs(call.arguments);
	const modelCall = { name: call.name, arguments: received };
	if (call.ownedNames?.has(call.name)) return { name: call.name, arguments: received, modelCall };
	const wrongCase = CC_TOOLS.find(
		(tool) => tool.name.toLowerCase() === call.name.toLowerCase() && tool.name !== call.name,
	);
	if (wrongCase) {
		return {
			name: wrongCase.pi,
			arguments: {},
			inputError: unavailableToolText(call.name, `Tool names are case-sensitive: call ${wrongCase.name} instead.`),
			modelCall,
		};
	}
	const covered = ccToolByDeclaredName(call.name);
	if (!covered) return { name: call.name, arguments: received, modelCall };
	if (call.active && !call.active.has(covered.pi)) {
		return {
			name: covered.pi,
			arguments: {},
			inputError: unavailableToolText(
				call.name,
				`${call.name} is disabled for this session, in subagents as well as here.`,
			),
			modelCall,
		};
	}
	if (call.argumentsError !== undefined) {
		return {
			name: covered.pi,
			arguments: {},
			inputError: `<tool_use_error>${call.argumentsError}</tool_use_error>`,
			modelCall,
		};
	}
	const args = copyArgs(call.arguments);
	const issues = validateInput(covered, args);
	if (issues.length > 0) {
		return { name: covered.pi, arguments: {}, inputError: inputValidationText(covered.name, issues), modelCall };
	}
	if (covered.pi === "read") {
		const rangeIssues = (["offset", "limit"] as const).flatMap((field) => {
			const value = args[field];
			return typeof value === "number" && value > Number.MAX_SAFE_INTEGER
				? [
						{
							code: "too_big",
							maximum: Number.MAX_SAFE_INTEGER,
							note: "Integers must be within the safe integer range.",
							origin: "int",
							inclusive: true,
							path: [field],
							message: "Too big: expected int to be <=9007199254740991",
						},
					]
				: [];
		});
		if (rangeIssues.length > 0) {
			return {
				name: covered.pi,
				arguments: {},
				inputError: `<tool_use_error>InputValidationError: ${JSON.stringify(rangeIssues, null, 2)}</tool_use_error>`,
				modelCall,
			};
		}
	}
	return {
		name: covered.pi,
		arguments: covered.toPi(args),
		modelCall: { name: covered.name, arguments: echoedArgs(covered, args) },
	};
}

function unavailableToolText(name: string, suffix: string): string {
	return `<tool_use_error>Error: No such tool available: ${name}. ${suffix}</tool_use_error>`;
}

function copyArgs(value: unknown): JsonObject {
	const args = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	return structuredClone(args) as JsonObject;
}

function echoedArgs(tool: CcTool, coerced: Record<string, unknown>): JsonObject {
	if (tool.name !== "Edit") return coerced as JsonObject;
	return { ...coerced, replace_all: coerced.replace_all === true };
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
			// For a number field, Claude Code reads a numeric string as its number before it reports the type.
			const types = Array.isArray(declared) ? declared : [declared];
			const isNumberField = types.includes("number") || types.includes("integer");
			const shown = (isNumberField ? numericString(value) : undefined) ?? value;
			issues.push(
				`The parameter \`${key}\` type is expected as \`${expectedTypeName(declared, shown)}\` but provided as \`${jsonType(shown)}\``,
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

/** The string forms Claude Code reads as a number, measured in the harness: no exponent, hex, or bare dot. */
const NUMERIC_STRING = /^[+-]?\d+(\.\d+)?$/;

function numericString(value: unknown): number | undefined {
	return typeof value === "string" && NUMERIC_STRING.test(value.trim()) ? Number(value) : undefined;
}

function coerceToType(value: unknown, type: string): unknown {
	switch (type) {
		case "string":
			return typeof value === "string" ? value : undefined;
		case "number": {
			const number = typeof value === "number" ? value : numericString(value);
			return number !== undefined && Number.isFinite(number) ? number : undefined;
		}
		case "integer": {
			const number = typeof value === "number" ? value : numericString(value);
			return number !== undefined && Number.isInteger(number) ? number : undefined;
		}
		case "boolean":
			if (typeof value === "boolean") return value;
			if (value === "true") return true;
			if (value === "false") return false;
			return undefined;
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

/** Claude Code reports an integer field as `number` until the value is a number, then as `int`. */
function expectedTypeName(declared: string | string[], value: unknown): string {
	const type = Array.isArray(declared) ? declared.join(" | ") : declared;
	if (type !== "integer") return type;
	return typeof value === "number" ? "int" : "number";
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
	/**
	 * Whether the model accepts system messages after the conversation starts. Default: true. When
	 * false, the transport folds every later system message into the leading one, so a tool-result
	 * notice rides inside its own tool result, wrapped the way Claude Code wraps it. Nested memory
	 * follows the same split: a text block after the tool results when true, inside the last tool
	 * result when false.
	 */
	midConversationSystemMessages?: boolean;
}

/**
 * Project the transcript a provider call will send: declared tools become the ones Claude Code
 * declares. The stored transcript is not modified.
 */
export function projectMessagesForModel(messages: readonly Message[], options?: CcSurfaceOptions): Message[] {
	const includePlaceholder = options?.placeholder !== false;
	const foldIntoResult = options?.midConversationSystemMessages === false;
	let nestedReminders: string[] = [];
	const projected = messages.flatMap((message, index, all): Message[] => {
		if (message.role === "system") {
			if (message.sections !== undefined) {
				const sections = Object.fromEntries(
					Object.entries(message.sections).map(([name, text]) => {
						if (typeof text !== "string") return [name, text];
						const lines = projectPromptLines(text);
						return [name, name === "tools" || name === "rules" ? projectToolList(lines) : lines];
					}),
				);
				message = { ...message, sections };
			}
			const toolsAdded = message.toolsAdded;
			if (toolsAdded === undefined) return [message];
			const projected = projectDeclarations(toolsAdded, includePlaceholder);
			// A removal names a pi tool; the model knows the tool by its Claude Code name.
			const toolsRemoved = message.toolsRemoved?.map((tool) => ({
				...tool,
				name: ccTool(tool.name)?.name ?? tool.name,
			}));
			return [
				{
					...message,
					toolsAdded: projected,
					...(toolsRemoved === undefined ? {} : { toolsRemoved }),
				},
			];
		}
		if (message.role === "assistant") {
			return [{ ...message, content: message.content.map(projectHistoryBlock) }];
		}
		if (message.role === "toolResult") {
			const { result, reminders } = takeNestedReminders(message);
			nestedReminders.push(...reminders);
			const notice = noticeOf(result);
			const out: Message[] = [result];
			if (notice) {
				if (foldIntoResult) out[0] = withNoticeInResult(result, notice);
				else out.push({ role: "system", content: notice, timestamp: result.timestamp });
			}
			if (nestedReminders.length === 0 || all[index + 1]?.role === "toolResult") return out;
			const run = nestedReminders;
			nestedReminders = [];
			return placeNestedReminders(out, run, foldIntoResult);
		}
		return [message];
	});
	return sortMergedDeclarations(projected, includePlaceholder);
}

/**
 * The provider merges every `toolsAdded` in arrival order. Sort that merge onto the first
 * declaration so a resumed session does not keep the order tools were registered in.
 */
export function sortMergedDeclarations(messages: readonly Message[], includePlaceholder: boolean): Message[] {
	const merged = new Map<string, Tool>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsRemoved ?? []) merged.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) merged.set(tool.name, tool);
	}
	if (merged.size === 0) return [...messages];
	const sorted = projectDeclarations([...merged.values()], includePlaceholder);
	let placed = false;
	return messages.map((message) => {
		if (message.role !== "system" || (message.toolsAdded === undefined && message.toolsRemoved === undefined)) {
			return message;
		}
		if (!placed && message.toolsAdded !== undefined) {
			placed = true;
			const { toolsRemoved: _removed, ...rest } = message;
			return { ...rest, toolsAdded: sorted };
		}
		const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
		return rest;
	});
}

/**
 * System prompt lines that describe pi's input shape or tool names, and the line the model gets
 * instead. `null` drops a line that has no counterpart for a one-edit schema.
 */
const [editExact, editMany, editOriginal, editSmall, editApprox] = editToolSystemPromptContribution.guidelines;
const MODEL_PROMPT_LINES: ReadonlyMap<string, string | null> = new Map([
	[editToolSystemPromptContribution.snippet, "Make precise file edits with exact text replacement"],
	[editExact, "Use Edit for precise changes (old_string must match exactly)"],
	[editMany, "To change several separate locations in one file, make one Edit call for each"],
	[editOriginal, null],
	[
		editSmall,
		"Keep old_string as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
	],
	[
		editApprox,
		"An old_string that matches the file only approximately is not applied. Re-read the file and copy the exact text.",
	],
	[
		"Use the read tool to load a skill's file when the task matches its description.",
		"Use the Read tool to load a skill's file when the task matches its description.",
	],
	[
		"Use bash to load a skill's file when the task matches its description.",
		"Use Bash to load a skill's file when the task matches its description.",
	],
]);

/** Each line of a prompt section as the model reads it, a bullet's marker and a tool list's `name: ` kept. */
function projectPromptLines(text: string): string {
	return text
		.split("\n")
		.flatMap((line) => {
			const [, prefix = "", body = line] = /^(- (?:[A-Za-z_]+: )?)?(.*)$/.exec(line) ?? [];
			const replaced = MODEL_PROMPT_LINES.get(body);
			if (replaced === undefined) return [line];
			return replaced === null ? [] : [`${prefix}${replaced}`];
		})
		.join("\n");
}

/**
 * The system prompt's tool list and tool rules, with each covered tool under the name the model
 * calls it by: a `- read: ...` entry and a `- Use read ...` rule.
 */
function projectToolList(text: string): string {
	return text.replace(/^- (Use )?([A-Za-z_]+)(?=[: ])/gm, (line, use: string | undefined, name: string) => {
		const covered = ccTool(name);
		return covered ? `- ${use ?? ""}${covered.name}` : line;
	});
}

function projectHistoryBlock(block: AssistantMessage["content"][number]): AssistantMessage["content"][number] {
	if (block.type !== "toolCall") return block;
	const echoed = block.modelCall ?? reverseMap(block);
	const { modelCall: _recorded, ...rest } = block;
	return { ...rest, name: echoed.name, arguments: { ...echoed.arguments } };
}

/** A session written before the original call was recorded. Description and background are gone. */
function reverseMap(block: ToolCall): { name: string; arguments: JsonObject } {
	const covered = ccTool(block.name);
	if (!covered) return { name: block.name, arguments: block.arguments };
	const args = block.arguments;
	if (covered.pi === "bash") {
		return {
			name: "Bash",
			arguments: {
				command: args.command,
				...(args.timeout === undefined ? {} : { timeout: Number(args.timeout) * 1000 }),
			},
		};
	}
	if (covered.pi === "edit") {
		const edits = Array.isArray(args.edits) ? args.edits : [];
		const first = edits[0] && typeof edits[0] === "object" ? (edits[0] as Record<string, JsonObject[string]>) : {};
		return {
			name: "Edit",
			arguments: {
				file_path: args.path,
				old_string: first.oldText ?? "",
				new_string: first.newText ?? "",
				replace_all: args.replaceAll === true,
			},
		};
	}
	if (covered.pi === "read") {
		return {
			name: "Read",
			arguments: {
				file_path: args.path,
				...(args.offset === undefined ? {} : { offset: args.offset }),
				...(args.limit === undefined ? {} : { limit: args.limit }),
				...(args.allowLarge === undefined ? {} : { allow_large: args.allowLarge }),
			},
		};
	}
	return { name: "Write", arguments: { file_path: args.path, content: args.content } };
}

function noticeOf(message: Message): string | undefined {
	if (message.role !== "toolResult" || message.details === undefined || message.details === null) return undefined;
	if (typeof message.details !== "object" || Array.isArray(message.details)) return undefined;
	const notice = (message.details as { ccNotice?: unknown }).ccNotice;
	return typeof notice === "string" && notice.length > 0 ? notice : undefined;
}

/**
 * The notice as Claude Code answers a model that cannot take mid-conversation system messages:
 * appended to the tool result it explains, inside `<system-reminder>` tags (measured on
 * claude-haiku-4-5, which answers a model that can with its own system message).
 */
function withNoticeInResult(message: ToolResultMessage, notice: string): ToolResultMessage {
	return appendToResult(message, `<system-reminder>\n${notice}\n</system-reminder>`);
}

function appendToResult(message: ToolResultMessage, text: string): ToolResultMessage {
	const content = [...message.content];
	const last = content[content.length - 1];
	if (last !== undefined && last.type === "text") {
		content[content.length - 1] = { ...last, text: `${last.text}\n\n${text}` };
	} else {
		content.push({ type: "text", text });
	}
	return { ...message, content };
}

function takeNestedReminders(message: ToolResultMessage): { result: ToolResultMessage; reminders: string[] } {
	const reminders: string[] = [];
	const content = message.content.filter((block) => {
		if (!isInjectedReminder(block)) return true;
		reminders.push(block.text);
		return false;
	});
	return { result: reminders.length === 0 ? message : { ...message, content }, reminders };
}

function placeNestedReminders(out: Message[], reminders: string[], foldIntoResult: boolean): Message[] {
	const [result, ...rest] = out as [ToolResultMessage, ...Message[]];
	if (foldIntoResult) return [appendToResult(result, reminders.join("\n\n")), ...rest];
	const texts = reminders.filter((text) => !isAgentsReminder(text));
	const placed: Message[] = [result];
	if (texts.length > 0) {
		placed.push({
			role: "user",
			content: texts.map((text) => ({ type: "text", text })),
			timestamp: result.timestamp,
		});
	}
	placed.push(...rest);
	const agents = reminders.filter(isAgentsReminder);
	if (agents.length > 0) placed.push({ role: "system", content: agents.join("\n"), timestamp: result.timestamp });
	return placed;
}

/**
 * Project one assistant message the model returned into the pi message the loop records: a tool
 * call that Claude Code named and shaped becomes the pi call that runs it.
 */
export interface ProjectCallOptions {
	active?: ReadonlySet<string>;
	ownedNames?: ReadonlySet<string>;
}

export function projectAssistantMessageForPi(
	message: AssistantMessage,
	options?: ProjectCallOptions,
): AssistantMessage {
	let changed = false;
	const content = message.content.map((block) => {
		if (block.type !== "toolCall") return block;
		const projected = projectToolCall({ ...block, ...options });
		changed = true;
		const next = {
			...block,
			name: projected.name,
			arguments: projected.arguments as JsonObject,
			...(projected.modelCall === undefined ? {} : { modelCall: projected.modelCall }),
		};
		if (projected.inputError === undefined) delete next.argumentsError;
		else next.argumentsError = projected.inputError;
		return next;
	});
	return changed ? { ...message, content } : message;
}

/**
 * Give a still-streaming call pi's name and argument shape without validating it, so a preview
 * matches the call that runs. A partial's arguments are not the call yet.
 */
function projectPartialCalls(message: AssistantMessage, options?: ProjectCallOptions): AssistantMessage {
	const content = message.content.map((block) => {
		if (block.type !== "toolCall") return block;
		const covered = options?.ownedNames?.has(block.name) ? undefined : ccToolByDeclaredName(block.name);
		if (!covered) return { ...block, arguments: { ...block.arguments } };
		return { ...block, name: covered.pi, arguments: covered.toPi({ ...block.arguments }) as JsonObject };
	});
	return { ...message, content };
}

function projectStreamEvent(event: AssistantMessageEvent, options?: ProjectCallOptions): AssistantMessageEvent {
	switch (event.type) {
		case "done":
			return { ...event, message: projectAssistantMessageForPi(event.message, options) };
		case "error":
			return { ...event, error: projectAssistantMessageForPi(event.error, options) };
		case "toolcall_end": {
			const partial = projectAssistantMessageForPi(event.partial, options);
			const toolCall = partial.content[event.contentIndex];
			return {
				...event,
				partial,
				toolCall: toolCall?.type === "toolCall" ? toolCall : event.toolCall,
			};
		}
		default:
			return { ...event, partial: projectPartialCalls(event.partial, options) };
	}
}

/**
 * Wrap a provider stream so the loop only ever sees pi's tool names and arguments, while the
 * provider only ever sees Claude Code's. Every other event passes through untouched.
 */
export function wrapStreamFn(stream: StreamFn, toolNames?: () => readonly string[]): StreamFn {
	return (model, context, options) => {
		const names = toolNames?.();
		const callOptions: ProjectCallOptions | undefined =
			names === undefined
				? undefined
				: {
						active: new Set(names),
						ownedNames: new Set(names.filter((name) => ccToolByDeclaredName(name))),
					};
		const response = stream(model, context, options);
		const project = (settled: AssistantMessageEventStream) => projectStream(settled, model, callOptions);
		return response instanceof Promise ? response.then(project) : project(response);
	};
}

function projectStream(
	stream: AssistantMessageEventStream,
	model: Model<any>,
	options?: ProjectCallOptions,
): AssistantMessageEventStream {
	const projected = new AssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of stream) projected.push(projectStreamEvent(event, options));
			// A stream can finish with end(message) and no done event. Forward that message, or the
			// loop waits forever on result().
			projected.end(projectAssistantMessageForPi(await stream.result(), options));
		} catch (error) {
			projected.end({
				role: "assistant",
				content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
				stopReason: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
				api: model.api,
				provider: model.provider,
				model: model.id,
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
