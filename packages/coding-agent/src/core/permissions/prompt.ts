/**
 * Asking: the choices a prompt offers, the typed answer every surface (terminal, RPC, SDK
 * control channel) returns, and how an answer changes the session.
 *
 * An answer is allow or deny. An allow carries a grant scope: `once` changes nothing, `session`
 * adds rules that last until the process ends, `always` also writes them to the project's local
 * settings. Answers may add rules and set the mode, but an answer that adds a deny or ask rule
 * cannot carry a `!` exception, because an answer may only tighten.
 */

import type { PermissionState } from "./context.ts";
import type { PermissionMode } from "./mode.ts";
import { isPermissionMode } from "./mode.ts";
import { persistAllowRule } from "./persist.ts";
import { formatRule, type RuleBehavior } from "./rules.ts";
import { type PermissionCall, toolTraits } from "./tool-checks.ts";

export type GrantScope = "once" | "session" | "always";

export type PermissionUpdate =
	| {
			readonly type: "addRules";
			readonly rules: readonly string[];
			readonly behavior: RuleBehavior;
			readonly destination: "session" | "localSettings";
	  }
	| { readonly type: "setMode"; readonly mode: PermissionMode };

export type PermissionAnswer =
	| { readonly behavior: "allow"; readonly updates?: readonly PermissionUpdate[] }
	| { readonly behavior: "deny"; readonly message: string; readonly interrupt?: boolean };

export interface PermissionRequest {
	readonly call: PermissionCall;
	readonly toolCallId: string;
	readonly message: string;
	readonly suggestions: readonly Suggestion[];
}

export interface Suggestion {
	readonly label: string;
	readonly update: PermissionUpdate;
}

/** Answers a request. `undefined` means nobody can answer, which denies the call. */
export type PermissionPrompter = (request: PermissionRequest) => Promise<PermissionAnswer | undefined>;

export const YES = "Yes";
export const NO = "No, and tell Claude what to do differently (esc)";

export const REJECTED_WITHOUT_REASON =
	"Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). Try a different approach or report the limitation to complete your task.";

/** The "don't ask again" choices for an ask, as Claude Code offers them. */
export function suggestionsFor(call: PermissionCall, cwd: string): Suggestion[] {
	const { kind } = toolTraits(call.name);
	if (kind === "edit") {
		return [{ label: "Yes, allow all edits during this session", update: { type: "setMode", mode: "acceptEdits" } }];
	}
	const command = call.input.command;
	const rule =
		kind === "shell" && typeof command === "string"
			? formatRule({ toolName: call.name, content: command })
			: formatRule({ toolName: call.name });
	const subject = kind === "shell" && typeof command === "string" ? command : call.name;
	return [
		{
			label: `Yes, and don't ask again for ${subject} in ${cwd}`,
			update: { type: "addRules", rules: [rule], behavior: "allow", destination: "localSettings" },
		},
	];
}

export function grantScope(answer: PermissionAnswer): GrantScope {
	if (answer.behavior === "deny") return "once";
	const updates = answer.updates ?? [];
	if (updates.some((update) => update.type === "addRules" && update.destination === "localSettings")) return "always";
	return updates.length > 0 ? "session" : "once";
}

export function applyUpdates(state: PermissionState, updates: readonly PermissionUpdate[], project: string): string[] {
	const refused: string[] = [];
	for (const update of updates) {
		if (update.type === "setMode") {
			if (isPermissionMode(update.mode)) state.setMode(update.mode);
			continue;
		}
		const accepted = update.rules.filter((rule) => update.behavior === "allow" || !hasException(rule));
		refused.push(...update.rules.filter((rule) => !accepted.includes(rule)));
		state.addRules(accepted, update.behavior, "session");
		if (update.destination === "localSettings" && update.behavior === "allow") {
			for (const rule of accepted) persistAllowRule(project, rule);
		}
	}
	return refused;
}

/** A `!` exception inside a rule's content widens what the rule leaves out, so a deny or ask rule may not carry one. */
function hasException(ruleText: string): boolean {
	const open = ruleText.indexOf("(");
	return (
		open !== -1 &&
		ruleText
			.slice(open + 1)
			.trimStart()
			.startsWith("!")
	);
}
