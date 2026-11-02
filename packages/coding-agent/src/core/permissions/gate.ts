/**
 * The session's permission gate: evaluate a call, then deny it, allow it, or ask.
 *
 * One gate per session. It owns the mutable {@link PermissionState}, queues prompts so one
 * question is on screen at a time, and re-evaluates a call after it waited, because an answer given
 * to an earlier call may already cover it.
 */

import type { PermissionState } from "./context.ts";
import { type Decision, defaultAskMessage } from "./decision.ts";
import { applyDontAsk, evaluatePermission } from "./evaluate.ts";
import {
	applyUpdates,
	type PermissionAnswer,
	type PermissionPrompter,
	type Suggestion,
	suggestionsFor,
} from "./prompt.ts";
import { checkTool, type PermissionCall } from "./tool-checks.ts";

export type GateOutcome =
	| { readonly action: "run"; readonly updatedInput?: Readonly<Record<string, unknown>> }
	| { readonly action: "refuse"; readonly message: string; readonly interrupt?: boolean };

/** What hooks add to a decision: a PreToolUse verdict, PermissionRequest hooks before the prompt, PermissionDenied after a refusal. */
export interface PermissionHooks {
	/** A PermissionRequest hook's answer, or undefined when none answered. */
	request?(
		call: PermissionCall,
		toolCallId: string,
		suggestions: readonly Suggestion[],
		/** A rule holds the ask, so no "don't ask again" choice exists. */
		heldByRule: boolean,
	): Promise<(PermissionAnswer & { readonly updatedInput?: Readonly<Record<string, unknown>> }) | undefined>;
	denied?(call: PermissionCall, toolCallId: string, reason: string): Promise<void>;
}

/** A PreToolUse hook's say on the call: `allow` skips the prompt, `ask` forces one. Rules that deny still deny. */
export interface HookPreference {
	readonly permission: "allow" | "ask";
	readonly reason?: string;
}

export interface PermissionGateOptions {
	readonly state: PermissionState;
	readonly hooks?: PermissionHooks;
	readonly prompter?: () => PermissionPrompter | undefined;
	readonly prompts?: "host" | "none";
}

export class PermissionGate {
	private readonly state: PermissionState;
	private readonly prompter: () => PermissionPrompter | undefined;
	private readonly prompts: "host" | "none";
	private readonly hooks: PermissionHooks | undefined;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(options: PermissionGateOptions) {
		this.state = options.state;
		this.prompter = options.prompter ?? (() => undefined);
		this.prompts = options.prompts ?? "host";
		this.hooks = options.hooks;
	}

	async decide(call: PermissionCall, toolCallId: string, preference?: HookPreference): Promise<GateOutcome> {
		if (preference?.permission === "ask" && (this.prompts === "none" || this.prompter() === undefined)) {
			return this.refused(call, toolCallId, preference.reason ?? defaultAskMessage(call.name));
		}
		const first = this.evaluate(call, preference);
		if (first.behavior === "deny") return this.refused(call, toolCallId, first.message);
		if (first.behavior === "allow") return { action: "run" };
		const suggestions = suggestionsFor(call, this.state.current().cwd);
		const prompter = this.prompts === "none" ? undefined : this.prompter();
		const hooked = await this.hooks?.request?.(call, toolCallId, suggestions, first.reason?.type === "rule");
		if (hooked) return this.apply(hooked);
		if (prompter === undefined) return this.refused(call, toolCallId, first.message);
		return this.serialized(async () => {
			const again = this.evaluate(call, preference);
			if (again.behavior !== "ask") return outcomeOf(again);
			const answer = await prompter({ call, toolCallId, message: again.message, suggestions });
			return answer === undefined ? this.refused(call, toolCallId, again.message) : this.apply(answer);
		});
	}

	private async refused(call: PermissionCall, toolCallId: string, message: string): Promise<GateOutcome> {
		await this.hooks?.denied?.(call, toolCallId, message);
		return { action: "refuse", message };
	}

	/** Whether Read on the path would run without asking, which is when a file the model never read may still be edited. */
	readAutoAllowed(path: string): boolean {
		const ctx = this.state.current();
		const call: PermissionCall = { name: "Read", input: { file_path: path } };
		if (ctx.rules.wholeTool("deny", "Read") || ctx.rules.wholeTool("ask", "Read")) return false;
		const check = checkTool(call, ctx);
		if (check.behavior === "allow") return true;
		return check.behavior === "ask" && check.reason?.type !== "rule" && ctx.mode === "bypassPermissions";
	}

	private evaluate(call: PermissionCall, preference?: HookPreference): Decision {
		const ctx = this.state.current();
		const decision = applyPreference(evaluatePermission(call, ctx).decision, call, preference);
		return applyDontAsk(decision, call, ctx);
	}

	private apply(
		answer: PermissionAnswer & { readonly updatedInput?: Readonly<Record<string, unknown>> },
	): GateOutcome {
		if (answer.behavior === "deny") {
			return {
				action: "refuse",
				message: answer.message,
				...(answer.interrupt === undefined ? {} : { interrupt: answer.interrupt }),
			};
		}
		applyUpdates(this.state, answer.updates ?? [], this.state.current().cwd);
		return answer.updatedInput ? { action: "run", updatedInput: answer.updatedInput } : { action: "run" };
	}

	private serialized<T>(task: () => Promise<T>): Promise<T> {
		const next = this.queue.then(task, task);
		this.queue = next.catch(() => undefined);
		return next;
	}
}

function outcomeOf(decision: Decision): GateOutcome {
	return decision.behavior === "allow" ? { action: "run" } : { action: "refuse", message: decision.message };
}

/**
 * A hook's `allow` answers an ask nothing holds in place (a rule, plan mode or a safety check stands
 * behind the rest), and its `ask` turns an allow into an ask. A deny is final either way.
 */
function applyPreference(decision: Decision, call: PermissionCall, preference: HookPreference | undefined): Decision {
	if (preference === undefined || decision.behavior === "deny") return decision;
	if (preference.permission === "ask") {
		if (decision.behavior === "ask" && preference.reason === undefined) return decision;
		const reason = decision.behavior === "ask" ? decision.reason : undefined;
		return {
			behavior: "ask",
			message: preference.reason ?? defaultAskMessage(call.name),
			...(reason ? { reason } : {}),
		};
	}
	if (decision.behavior !== "ask") return decision;
	const held = decision.reason?.type === "rule" || decision.reason?.type === "safetyCheck";
	return held ? decision : { behavior: "allow" };
}
