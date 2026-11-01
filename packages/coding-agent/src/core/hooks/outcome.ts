/**
 * Reading one handler's result: exit code, stdout JSON and the event table's rules become an
 * {@link Outcome}, and a list of outcomes folds into one {@link Verdict} with {@link mergeOutcomes}.
 */

import { EVENT_TABLE, type HookEvent } from "./events.ts";
import type { RawResult } from "./process.ts";

export type Permission = "allow" | "ask" | "deny" | "defer";
const PERMISSION_RANK: Readonly<Record<Permission, number>> = { defer: 0, allow: 1, ask: 2, deny: 3 };

/** A PermissionRequest hook's answer. */
export type RequestDecision =
	| {
			readonly behavior: "allow";
			readonly updatedInput?: Readonly<Record<string, unknown>>;
			readonly updatedPermissions?: readonly unknown[];
	  }
	| { readonly behavior: "deny"; readonly message?: string; readonly interrupt?: boolean };

/** Why a hook blocked: `text` is what Claude Code shows for it, `reason` the bare reason. */
export interface Block {
	readonly text: string;
	readonly reason: string;
	/** Exit code 2 blocked it, as opposed to a JSON decision. */
	readonly viaExit: boolean;
}

export interface Outcome {
	/** Why the guarded action must not happen. For a tool or prompt event this text reaches the model. */
	readonly block?: Block;
	readonly permission?: Permission;
	readonly permissionReason?: string;
	readonly requestDecision?: RequestDecision;
	readonly updatedInput?: Readonly<Record<string, unknown>>;
	readonly updatedToolOutput?: unknown;
	/** Text a hook printed that Claude Code adds to the context as it is, for the events that take it. */
	readonly output?: string;
	/** Text for the model's context, from `additionalContext`. */
	readonly context?: string;
	/** Text only the user sees. */
	readonly systemMessage?: string;
	/** `continue: false`: stop the agent, with the user-facing reason. */
	readonly stop?: string;
	readonly suppressOutput?: boolean;
	readonly terminalSequence?: string;
	/** A failure that does not block: a bad exit code, a timeout, or output that is not valid. */
	readonly error?: string;
	/** The command or URL that produced the outcome. */
	readonly source?: string;
}

const reasonBlock = (reason: string): Block => ({ text: reason, reason, viaExit: false });

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

export function parseJsonOutput(stdout: string): Json | undefined {
	const trimmed = stdout.trim();
	if (!trimmed.startsWith("{")) return undefined;
	try {
		const value: unknown = JSON.parse(trimmed);
		return isObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function permissionOf(value: unknown): Permission | undefined {
	return value === "allow" || value === "ask" || value === "deny" || value === "defer" ? value : undefined;
}

function requestDecisionOf(specific: Json): RequestDecision | undefined {
	const decision = specific.decision;
	if (!isObject(decision)) return undefined;
	if (decision.behavior === "allow") {
		return {
			behavior: "allow",
			...(isObject(decision.updatedInput) ? { updatedInput: decision.updatedInput } : {}),
			...(Array.isArray(decision.updatedPermissions) ? { updatedPermissions: decision.updatedPermissions } : {}),
		};
	}
	if (decision.behavior === "deny") {
		return {
			behavior: "deny",
			...(text(decision.message) ? { message: text(decision.message) as string } : {}),
			...(decision.interrupt === true ? { interrupt: true } : {}),
		};
	}
	return undefined;
}

function fromJson(event: HookEvent, json: Json): Outcome {
	const spec = EVENT_TABLE[event];
	const specific = isObject(json.hookSpecificOutput) ? json.hookSpecificOutput : {};
	const specificMatches = specific.hookEventName === undefined || specific.hookEventName === event;
	const own = specificMatches ? specific : {};
	const reason = text(json.reason);
	const outcome: { -readonly [K in keyof Outcome]: Outcome[K] } = {};

	if (event === "PreToolUse") {
		const legacy = json.decision === "approve" ? "allow" : json.decision === "block" ? "deny" : undefined;
		const permission = permissionOf(own.permissionDecision) ?? legacy;
		if (permission) outcome.permission = permission;
		const why = text(own.permissionDecisionReason) ?? reason;
		if (why) outcome.permissionReason = why;
		if (permission === "deny") outcome.block = reasonBlock(why ?? "Blocked by hook");
		if (isObject(own.updatedInput)) outcome.updatedInput = own.updatedInput;
	} else if (event === "PermissionRequest") {
		const decision = requestDecisionOf(own);
		if (decision) outcome.requestDecision = decision;
	} else if (spec.decisionBlocks && json.decision === "block") {
		outcome.block = reasonBlock(reason ?? `Blocked by a ${event} hook.`);
	}
	if (event === "PostToolUse") {
		const replaced = own.updatedToolOutput ?? own.updatedMCPToolOutput;
		if (replaced !== undefined) outcome.updatedToolOutput = replaced;
	}
	const context = text(own.additionalContext);
	if (context) outcome.context = context;
	const message = text(json.systemMessage);
	if (message) outcome.systemMessage = message;
	if (json.continue === false) outcome.stop = text(json.stopReason) ?? `A ${event} hook stopped the agent.`;
	if (json.suppressOutput === true) outcome.suppressOutput = true;
	const sequence = text(json.terminalSequence);
	if (sequence) outcome.terminalSequence = sequence;
	return outcome;
}

/** One handler's result read under the event's rules. */
export function interpret(
	event: HookEvent,
	result: RawResult,
	options: { readonly source: string; readonly onFailure?: "continue" | "block" },
): Outcome {
	const spec = EVENT_TABLE[event];
	const stderr = result.stderr.trim();
	const exitBlock = (raw: string): Block => ({
		text: `[${options.source}]: ${raw}`,
		reason: raw.trim(),
		viaExit: true,
	});
	const failed = (detail: string): Outcome =>
		options.onFailure === "block" && spec.exitTwo === "block" ? { block: exitBlock(detail) } : { error: detail };
	if (result.failure) return failed(`${event} hook ${result.failure}${stderr ? `: ${stderr}` : ""}`);
	if (result.status !== undefined) return interpretHttp(event, result, result.status);
	if (result.code === 2) {
		if (spec.exitTwo === "user") return { error: stderr || `Blocked by a ${event} hook.` };
		return { block: exitBlock(result.stderr === "" ? "No stderr output" : result.stderr) };
	}
	if (result.code !== 0) return failed(stderr || `exit code ${String(result.code)}`);
	const json = parseJsonOutput(result.stdout);
	if (json) return fromJson(event, json);
	const stdout = result.stdout.trim();
	return stdout && spec.stdoutIsContext ? { output: stdout } : {};
}

/** An http hook answers with a status, and a 2xx body must be JSON. */
function interpretHttp(event: HookEvent, result: RawResult, status: number): Outcome {
	if (status < 200 || status >= 300) return { error: result.stderr };
	const json = parseJsonOutput(result.stdout);
	if (json) return fromJson(event, json);
	return { error: `HTTP hook must return JSON, but got non-JSON response body: ${result.stdout}` };
}

/** The combined answer of every handler that ran for one event. */
export interface Verdict {
	readonly block?: string;
	/** Each block with the command that gave it. */
	readonly blocks: readonly (Block & { readonly source: string })[];
	readonly permission?: Permission;
	readonly permissionReason?: string;
	readonly requestDecision?: RequestDecision;
	readonly updatedInput?: Readonly<Record<string, unknown>>;
	readonly updatedToolOutput?: unknown;
	readonly outputs: readonly string[];
	readonly context: readonly string[];
	readonly systemMessages: readonly string[];
	readonly errors: readonly string[];
	readonly stop?: string;
	readonly terminalSequences: readonly string[];
}

export const EMPTY_VERDICT: Verdict = {
	blocks: [],
	outputs: [],
	context: [],
	systemMessages: [],
	errors: [],
	terminalSequences: [],
};

/**
 * Outcomes fold in completion order. Blocks and stops join, the strongest permission wins (deny,
 * then ask, then allow, and the later of two equals), and the last rewrite of the input or output wins.
 */
export function mergeOutcomes(outcomes: readonly Outcome[]): Verdict {
	const blockers = outcomes.flatMap((outcome) =>
		outcome.block === undefined ? [] : [{ ...outcome.block, source: outcome.source ?? "" }],
	);
	const stops = outcomes.flatMap((outcome) => outcome.stop ?? []);
	let permission: Permission | undefined;
	let permissionReason: string | undefined;
	for (const outcome of outcomes) {
		if (!outcome.permission) continue;
		if (permission === undefined || PERMISSION_RANK[outcome.permission] >= PERMISSION_RANK[permission]) {
			permission = outcome.permission;
			permissionReason = outcome.permissionReason;
		}
	}
	const last = <K extends keyof Outcome>(key: K): Outcome[K] | undefined =>
		outcomes.findLast((outcome) => outcome[key] !== undefined)?.[key];
	const decisions = outcomes.flatMap((outcome) => outcome.requestDecision ?? []);
	const requestDecision = decisions.find((decision) => decision.behavior === "deny") ?? decisions[0];
	const updatedInput = last("updatedInput");
	const updatedToolOutput = last("updatedToolOutput");
	return {
		...(blockers.length > 0 ? { block: blockers.map((block) => block.text).join("\n") } : {}),
		blocks: blockers,
		...(permission ? { permission } : {}),
		...(permissionReason ? { permissionReason } : {}),
		...(requestDecision ? { requestDecision } : {}),
		...(updatedInput ? { updatedInput } : {}),
		...(updatedToolOutput === undefined ? {} : { updatedToolOutput }),
		...(stops.length > 0 ? { stop: stops.join("\n") } : {}),
		outputs: outcomes.flatMap((outcome) => outcome.output ?? []),
		context: outcomes.flatMap((outcome) => outcome.context ?? []),
		systemMessages: outcomes.flatMap((outcome) => outcome.systemMessage ?? []),
		errors: outcomes.flatMap((outcome) => outcome.error ?? []),
		terminalSequences: outcomes.flatMap((outcome) => outcome.terminalSequence ?? []),
	};
}
