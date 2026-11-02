/** The text hooks put in front of the model and the user, in the words Claude Code uses. */

import type { HookEvent } from "./events.ts";

/** `Stop`, or `PreToolUse:Bash` when the event has a matcher value. */
export function hookLabel(event: HookEvent, matched: string | undefined): string {
	return matched === undefined ? event : `${event}:${matched}`;
}

export function reminder(text: string): string {
	return `<system-reminder>\n${text}\n</system-reminder>`;
}

/** What the model reads when a PreToolUse hook denies a call. */
export function deniedByHook(label: string, text: string): string {
	return `${label} hook error: ${text.trim()}`;
}

/** What follows a tool result when a PostToolUse hook gave feedback. */
export function blockingError(label: string, command: string, text: string): string {
	return `${label} hook blocking error from command: "${command}": ${text}`;
}

export function additionalContext(label: string, content: readonly string[]): string | undefined {
	return content.length === 0 ? undefined : `${label} hook additional context: ${content.join("\n")}`;
}

/** What a hook that printed plain text at SessionStart or UserPromptSubmit adds to the context. */
export function hookSuccess(label: string, output: string): string {
	return `${label} hook success: ${output}`;
}

export function stopFeedback(text: string): string {
	return `Stop hook feedback:\n${text}`;
}

export function stopCapNotice(count: number): string {
	return (
		`A hook blocked the turn from ending ${count} consecutive times — overriding and ending turn. ` +
		"For Stop/SubagentStop hooks, check stop_hook_active in the input and return success while it's true. " +
		"Set CLAUDE_CODE_STOP_HOOK_BLOCK_CAP to raise this limit."
	);
}

/** What the user reads when a UserPromptSubmit hook drops the prompt. */
export function promptBlocked(reason: string, prompt: string): string {
	return `UserPromptSubmit operation blocked by hook:\n${reason}\n\nOriginal prompt: ${prompt}`;
}

const DEFAULT_STOP_HOOK_CAP = 8;

/** `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` raises or lowers the cap. Zero turns it off. */
export function stopHookCap(env: Readonly<Record<string, string | undefined>> = process.env): number {
	const raw = env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP;
	const parsed = raw === undefined ? Number.NaN : Number(raw);
	return Number.isFinite(parsed) ? parsed : DEFAULT_STOP_HOOK_CAP;
}

const TERMINAL_SEQUENCE = /^(?:\x07|\x1b\](?:0|1|2|9|99|777);[^\x07\x1b]*(?:\x07|\x1b\\))+$/;

/**
 * A hook's `terminalSequence` reaches the terminal only when it is made of title and notification
 * OSC sequences and bells. Anything else, such as cursor movement or a screen clear, is dropped.
 */
export function allowedTerminalSequence(sequence: string): string | undefined {
	return TERMINAL_SEQUENCE.test(sequence) ? sequence : undefined;
}
