/**
 * The session's permission gate: evaluate a call, then deny it, allow it, or ask.
 *
 * One gate per session. It owns the mutable {@link PermissionState}, queues prompts so one
 * question is on screen at a time, and re-evaluates a call after it waited, because an answer given
 * to an earlier call may already cover it.
 */

import type { PermissionState } from "./context.ts";
import type { Decision } from "./decision.ts";
import { applyDontAsk, evaluatePermission } from "./evaluate.ts";
import { applyUpdates, type PermissionAnswer, type PermissionPrompter, suggestionsFor } from "./prompt.ts";
import { checkTool, type PermissionCall } from "./tool-checks.ts";

/** What the session does with the call: run it, or refuse it with the text the model reads. */
export type GateOutcome =
	| { readonly action: "run" }
	| { readonly action: "refuse"; readonly message: string; readonly interrupt?: boolean };

export interface PermissionGateOptions {
	readonly state: PermissionState;
	/** The surface that can answer an ask. Absent when nobody can. */
	readonly prompter?: () => PermissionPrompter | undefined;
	/** `none` refuses every ask without prompting (`--permission-prompts none`). */
	readonly prompts?: "host" | "none";
}

export class PermissionGate {
	private readonly state: PermissionState;
	private readonly prompter: () => PermissionPrompter | undefined;
	private readonly prompts: "host" | "none";
	private queue: Promise<unknown> = Promise.resolve();

	constructor(options: PermissionGateOptions) {
		this.state = options.state;
		this.prompter = options.prompter ?? (() => undefined);
		this.prompts = options.prompts ?? "host";
	}

	/** Decides one call. */
	async decide(call: PermissionCall, toolCallId: string): Promise<GateOutcome> {
		const first = this.evaluate(call);
		if (first.behavior !== "ask") return outcomeOf(first);
		const prompter = this.prompts === "none" ? undefined : this.prompter();
		if (prompter === undefined) return { action: "refuse", message: first.message };
		return this.serialized(async () => {
			const again = this.evaluate(call);
			if (again.behavior !== "ask") return outcomeOf(again);
			const answer = await prompter({
				call,
				toolCallId,
				message: again.message,
				suggestions: suggestionsFor(call, this.state.current().cwd),
			});
			return answer === undefined ? { action: "refuse", message: again.message } : this.apply(answer);
		});
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

	private evaluate(call: PermissionCall): Decision {
		const ctx = this.state.current();
		return applyDontAsk(evaluatePermission(call, ctx).decision, call, ctx);
	}

	private apply(answer: PermissionAnswer): GateOutcome {
		if (answer.behavior === "deny") {
			return {
				action: "refuse",
				message: answer.message,
				...(answer.interrupt === undefined ? {} : { interrupt: answer.interrupt }),
			};
		}
		applyUpdates(this.state, answer.updates ?? [], this.state.current().cwd);
		return { action: "run" };
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
