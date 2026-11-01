/** PreToolUse and PostToolUse hooks around one tool call: what they block, rewrite and add. */

import type { HookPreference } from "../permissions/gate.ts";
import { projectToolCall } from "../tools/cc-surface.ts";
import type { HookDispatcher } from "./dispatch.ts";
import { additionalContext, blockingError, deniedByHook, hookLabel, reminder } from "./messages.ts";

type Json = Record<string, unknown>;

export interface ToolHookCall {
	/** The name the model used (`Bash`, `Edit`). */
	readonly name: string;
	/** The input as the tool sees it: file paths are absolute. */
	readonly input: Json;
	readonly toolUseId: string;
}

export type PreToolResult =
	| { readonly kind: "block"; readonly reason: string }
	| {
			readonly kind: "go";
			readonly preference?: HookPreference;
			/** The pi arguments a hook's rewrite produced. */
			readonly rewrite?: Json;
			/** Text that follows the tool result as its own block. */
			readonly context: readonly string[];
			/** The input the call now has, as the model names its fields, with paths absolute. */
			readonly input: Json;
			/** Text the user sees. */
			readonly notices: readonly string[];
	  };

export async function preToolUse(
	hooks: HookDispatcher,
	call: ToolHookCall,
	signal: AbortSignal | undefined,
): Promise<PreToolResult> {
	if (!hooks.active("PreToolUse")) return { kind: "go", context: [], notices: [], input: call.input };
	const verdict = await hooks.run(
		"PreToolUse",
		{ tool_name: call.name, tool_input: call.input, tool_use_id: call.toolUseId },
		{ signal },
	);
	const label = hookLabel("PreToolUse", call.name);
	const block = verdict.blocks.at(-1);
	if (block !== undefined) return { kind: "block", reason: deniedByHook(label, block.text) };
	let rewrite: Json | undefined;
	let input = call.input;
	if (verdict.updatedInput) {
		input = { ...call.input, ...verdict.updatedInput };
		const projected = projectToolCall({ name: call.name, arguments: input });
		if (projected.inputError !== undefined) return { kind: "block", reason: projected.inputError };
		rewrite = projected.arguments;
	}
	const note = additionalContext(label, verdict.context);
	const permission = verdict.permission === "allow" || verdict.permission === "ask" ? verdict.permission : undefined;
	const reason =
		verdict.permissionReason ??
		(permission === "ask" ? `Hook ${label} asked for confirmation for this tool` : undefined);
	return {
		kind: "go",
		...(permission ? { preference: { permission, ...(reason ? { reason } : {}) } } : {}),
		...(rewrite ? { rewrite } : {}),
		context: note === undefined ? [] : [reminder(note)],
		input,
		notices: verdict.systemMessages,
	};
}

export interface PostToolResult {
	/** Hook text appended to the tool result the model reads. */
	readonly appended: string;
	/** A replacement for the tool's output, honored for tools whose output a hook may rewrite. */
	readonly replacement?: unknown;
	readonly notices: readonly string[];
	/** The agent must not continue: the reason a hook gave. */
	readonly stop?: string;
}

const NOTHING: PostToolResult = { appended: "", notices: [] };

/**
 * What the model reads in place of a tool's output, or undefined when the replacement does not fit the
 * tool. Bash takes an output object with a `stdout` string, and an MCP tool takes any value. A string
 * for Bash, and any replacement for another built-in tool, leaves the output as it was.
 */
export function replacementText(toolName: string, replacement: unknown): string | undefined {
	if (toolName.startsWith("mcp__")) return typeof replacement === "string" ? replacement : JSON.stringify(replacement);
	if (toolName !== "Bash" || typeof replacement !== "object" || replacement === null) return undefined;
	const { stdout, stderr } = replacement as { stdout?: unknown; stderr?: unknown };
	if (typeof stdout !== "string") return undefined;
	return [stdout.replace(/\n+$/, ""), typeof stderr === "string" ? stderr.replace(/\n+$/, "") : ""]
		.filter(Boolean)
		.join("\n");
}

export async function postToolUse(
	hooks: HookDispatcher,
	call: ToolHookCall & { readonly response: unknown; readonly error: string | undefined; readonly durationMs: number },
	signal: AbortSignal | undefined,
): Promise<PostToolResult> {
	const failed = call.error !== undefined;
	const event = failed ? "PostToolUseFailure" : "PostToolUse";
	if (!hooks.active(event)) return NOTHING;
	const verdict = failed
		? await hooks.run(
				"PostToolUseFailure",
				{
					tool_name: call.name,
					tool_input: call.input,
					tool_use_id: call.toolUseId,
					error: call.error,
					is_interrupt: false,
					duration_ms: call.durationMs,
				},
				{ signal },
			)
		: await hooks.run(
				"PostToolUse",
				{
					tool_name: call.name,
					tool_input: call.input,
					tool_response: call.response,
					tool_use_id: call.toolUseId,
					duration_ms: call.durationMs,
				},
				{ signal },
			);
	const label = hookLabel(event, call.name);
	const texts = verdict.blocks.map((block) => blockingError(label, block.source, block.text));
	const note = additionalContext(label, verdict.context);
	if (note !== undefined) texts.push(note);
	return {
		appended: texts.map((text) => `\n\n${reminder(text)}`).join(""),
		...(verdict.updatedToolOutput === undefined ? {} : { replacement: verdict.updatedToolOutput }),
		notices: verdict.systemMessages,
		...(verdict.stop === undefined ? {} : { stop: verdict.stop }),
	};
}
