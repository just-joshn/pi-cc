/** The JSON a hook receives on stdin: the common fields every event carries and the fields of each event. */

import { resolve } from "node:path";
import { type CommonScope, EVENT_TABLE, type HookEvent } from "./events.ts";

/** Where the session stands when an event fires. */
export interface HookSessionInfo {
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly cwd: string;
	readonly permissionMode: string;
	readonly agentId?: string;
	readonly agentType?: string;
	readonly effort?: string;
	readonly promptId?: string;
}

type Json = Record<string, unknown>;

/** The fields each event adds to the common ones. The table is the schema: its keys are the payload's keys. */
export interface EventFields {
	PreToolUse: { tool_name: string; tool_input: Json; tool_use_id: string };
	PostToolUse: {
		tool_name: string;
		tool_input: Json;
		tool_response: unknown;
		tool_use_id: string;
		duration_ms?: number;
	};
	PostToolUseFailure: {
		tool_name: string;
		tool_input: Json;
		tool_use_id: string;
		error: string;
		is_interrupt?: boolean;
		duration_ms?: number;
	};
	PostToolBatch: { tool_calls: readonly Json[] };
	PermissionRequest: { tool_name: string; tool_input: Json; permission_suggestions?: readonly unknown[] };
	PermissionDenied: { tool_name: string; tool_input: Json; tool_use_id: string; reason: string };
	Notification: { message: string; title?: string; notification_type: string };
	UserPromptSubmit: { prompt: string };
	UserPromptExpansion: {
		expansion_type: string;
		command_name: string;
		command_args: string;
		command_source?: string;
		prompt: string;
	};
	SessionStart: { source: string; agent_type?: string; model?: string };
	SessionEnd: { reason: string };
	Setup: { trigger: string };
	Stop: {
		stop_hook_active: boolean;
		last_assistant_message?: string;
		background_tasks?: readonly unknown[];
		session_crons?: readonly unknown[];
	};
	StopFailure: { error: string; error_details?: string; last_assistant_message?: string };
	SubagentStart: { agent_id: string; agent_type: string };
	SubagentStop: {
		stop_hook_active: boolean;
		agent_id: string;
		agent_transcript_path?: string;
		agent_type: string;
		last_assistant_message?: string;
	};
	PreCompact: { trigger: string; custom_instructions: string | null };
	PostCompact: { trigger: string; compact_summary: string };
	InstructionsLoaded: Json;
	ConfigChange: { source: string; file_path?: string };
	DirectoryAdded: { directory: string; source: string };
	FileChanged: { file_path: string; event: string };
	CwdChanged: { old_cwd: string; new_cwd: string };
	WorktreeCreate: { name: string };
	WorktreeRemove: { worktree_path: string };
	TaskCreated: Json;
	TaskCompleted: Json;
	TeammateIdle: Json;
	Elicitation: Json;
	ElicitationResult: Json;
}

export type HookInput<E extends HookEvent = HookEvent> = {
	[K in E]: { readonly hook_event_name: K } & EventFields[K] & Json;
}[E];

/** The fields every event's payload starts with. Absent values are left out of the JSON. */
export function commonFields(session: HookSessionInfo, scope: CommonScope = "full"): Json {
	return {
		session_id: session.sessionId,
		transcript_path: session.transcriptPath,
		cwd: session.cwd,
		...(session.promptId && scope !== "start" ? { prompt_id: session.promptId } : {}),
		...(scope === "start" || scope === "end" ? {} : { permission_mode: session.permissionMode }),
		...(session.agentId ? { agent_id: session.agentId } : {}),
		...(session.agentType ? { agent_type: session.agentType } : {}),
		...(session.effort && scope === "full" ? { effort: { level: session.effort } } : {}),
	};
}

export function buildInput<E extends HookEvent>(
	session: HookSessionInfo,
	event: E,
	fields: EventFields[E],
): HookInput<E> {
	return { ...commonFields(session, EVENT_TABLE[event].common), hook_event_name: event, ...fields } as HookInput<E>;
}

/** A tool input with its file paths made absolute, as the tool reports them to a hook. */
export function absolutePaths(input: Json, cwd: string): Json {
	const out: Json = { ...input };
	for (const key of ["file_path", "notebook_path"]) {
		const value = out[key];
		if (typeof value === "string") out[key] = resolve(cwd, value);
	}
	return out;
}
