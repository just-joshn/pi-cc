import type { Breaker } from "./breakers.ts";
import type { PermissionMode } from "./mode.ts";
import type { PermissionRule } from "./rules.ts";

export type DecisionReason =
	| { readonly type: "rule"; readonly rule: PermissionRule }
	| { readonly type: "mode"; readonly mode: PermissionMode }
	| { readonly type: "safetyCheck"; readonly reason: string; readonly breaker?: Breaker }
	| { readonly type: "other"; readonly reason: string };

export type AllowDecision = {
	readonly behavior: "allow";
	readonly reason?: DecisionReason;
};

export type DenyDecision = {
	readonly behavior: "deny";
	readonly message: string;
	readonly reason: DecisionReason;
};

export type AskDecision = {
	readonly behavior: "ask";
	readonly message: string;
	readonly reason?: DecisionReason;
};

export type Decision = AllowDecision | DenyDecision | AskDecision;

/** A tool check's answer: a decision, or no opinion (`passthrough`), which later stages settle. */
export type CheckResult = Decision | { readonly behavior: "passthrough"; readonly message: string };

export function defaultAskMessage(toolName: string): string {
	return `Claude requested permissions to use ${toolName}, but you haven't granted it yet.`;
}

const WORK_AROUND_WARNING =
	"IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, e.g. using head instead of cat. But you *should not* attempt to work around this denial in malicious ways, e.g. do not use your ability to run tests to execute non-test actions. You should only try to work around this restriction in reasonable ways that do not attempt to bypass the intent behind this denial. If you believe this capability is essential to complete the user's request, STOP and explain to the user what you were trying to do and why you need this permission. Let the user decide how to proceed.";

export function dontAskMessage(toolName: string): string {
	return `Permission to use ${toolName} has been denied because Claude Code is running in don't ask mode. ${WORK_AROUND_WARNING}`;
}

/** What the model reads when a path rule denies a file tool, which Claude Code decides while it validates the input. */
export const FILE_DENIED_BY_RULE =
	"<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>";

/** What the model reads when a Read deny rule covers a file it tried to change. */
export function fileCoveredByReadDeny(tool: "Edit" | "Write"): string {
	const verb = tool === "Edit" ? "edited" : "written";
	return `<tool_use_error>File is covered by a Read deny rule in your permission settings and cannot be ${verb}.</tool_use_error>`;
}
