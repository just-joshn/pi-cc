/**
 * The hook event table: every event Claude Code fires, what its matcher tests, and how a hook's exit
 * code and JSON answer are read for it. One row per event keeps those rules out of the dispatcher.
 */

export const HOOK_EVENTS = [
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"PostToolBatch",
	"PermissionRequest",
	"PermissionDenied",
	"Notification",
	"UserPromptSubmit",
	"UserPromptExpansion",
	"SessionStart",
	"SessionEnd",
	"Setup",
	"Stop",
	"StopFailure",
	"SubagentStart",
	"SubagentStop",
	"PreCompact",
	"PostCompact",
	"InstructionsLoaded",
	"ConfigChange",
	"DirectoryAdded",
	"FileChanged",
	"CwdChanged",
	"WorktreeCreate",
	"WorktreeRemove",
	"TaskCreated",
	"TaskCompleted",
	"TeammateIdle",
	"Elicitation",
	"ElicitationResult",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * What exit code 2 does:
 *   block     the action does not happen and stderr goes to the model
 *   feedback  the action already happened and stderr goes to the model
 *   user      the action goes on and stderr is shown to the user
 */
export type ExitTwo = "block" | "feedback" | "user";

export interface EventSpec {
	/** The input field a matcher tests, or undefined for an event whose hooks always run. */
	readonly matches: string | undefined;
	readonly exitTwo: ExitTwo;
	/** Whether `{"decision":"block"}` means something for the event. */
	readonly decisionBlocks: boolean;
	/** Whether plain stdout of a successful hook is context for the model. */
	readonly stdoutIsContext: boolean;
	/** Whether the matcher is read as a tool-name list or pattern. */
	readonly toolMatcher: boolean;
	/** Which common fields the payload carries. Session start has no prompt yet, session end has no mode, a prompt has no effort. */
	readonly common: CommonScope;
}

export type CommonScope = "start" | "end" | "prompt" | "full";

const row = (
	matches: string | undefined,
	exitTwo: ExitTwo,
	extra: Partial<Pick<EventSpec, "decisionBlocks" | "stdoutIsContext" | "toolMatcher" | "common">> = {},
): EventSpec => ({
	matches,
	exitTwo,
	decisionBlocks: extra.decisionBlocks ?? false,
	stdoutIsContext: extra.stdoutIsContext ?? false,
	toolMatcher: extra.toolMatcher ?? false,
	common: extra.common ?? "full",
});

export const EVENT_TABLE: Readonly<Record<HookEvent, EventSpec>> = {
	PreToolUse: row("tool_name", "block", { decisionBlocks: true, toolMatcher: true }),
	PostToolUse: row("tool_name", "feedback", { decisionBlocks: true, toolMatcher: true }),
	PostToolUseFailure: row("tool_name", "feedback", { toolMatcher: true }),
	PostToolBatch: row(undefined, "feedback"),
	PermissionRequest: row("tool_name", "block", { toolMatcher: true }),
	PermissionDenied: row("tool_name", "user", { toolMatcher: true }),
	Notification: row("notification_type", "user"),
	UserPromptSubmit: row(undefined, "block", { decisionBlocks: true, stdoutIsContext: true, common: "prompt" }),
	UserPromptExpansion: row("command_name", "block", { decisionBlocks: true }),
	SessionStart: row("source", "user", { stdoutIsContext: true, common: "start" }),
	SessionEnd: row("reason", "user", { common: "end" }),
	Setup: row("trigger", "user"),
	Stop: row(undefined, "block", { decisionBlocks: true }),
	StopFailure: row("error", "user"),
	SubagentStart: row("agent_type", "user"),
	SubagentStop: row("agent_type", "block", { decisionBlocks: true }),
	PreCompact: row("trigger", "block"),
	PostCompact: row("trigger", "user"),
	InstructionsLoaded: row("load_reason", "user"),
	ConfigChange: row("source", "block", { decisionBlocks: true }),
	DirectoryAdded: row("source", "user"),
	FileChanged: row("file_path", "user"),
	CwdChanged: row(undefined, "user"),
	WorktreeCreate: row(undefined, "block"),
	WorktreeRemove: row(undefined, "user"),
	TaskCreated: row(undefined, "block"),
	TaskCompleted: row(undefined, "block"),
	TeammateIdle: row(undefined, "block"),
	Elicitation: row("mcp_server_name", "block"),
	ElicitationResult: row("mcp_server_name", "block"),
};

export function isHookEvent(name: string): name is HookEvent {
	return Object.hasOwn(EVENT_TABLE, name);
}
