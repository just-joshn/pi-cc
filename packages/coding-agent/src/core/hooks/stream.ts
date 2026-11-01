/** What a session reports about its hooks to a host that streams them: each hook's start and end, and the notices around them. */

import type { HookEvent } from "./events.ts";

/** One hook's start or end, in the fields `--include-hook-events` reports. */
export type HookRecord =
	| {
			readonly subtype: "hook_started";
			readonly hook_id: string;
			readonly hook_name: string;
			readonly hook_event: HookEvent;
	  }
	| {
			readonly subtype: "hook_response";
			readonly hook_id: string;
			readonly hook_name: string;
			readonly hook_event: HookEvent;
			readonly output: string;
			readonly stdout: string;
			readonly stderr: string;
			readonly exit_code?: number;
			readonly outcome: "success" | "error" | "cancelled";
	  };

export type HookStreamItem =
	| HookRecord
	| {
			readonly subtype: "informational";
			readonly content: string;
			readonly level: "notice" | "warning";
			readonly extra?: Readonly<Record<string, unknown>>;
	  }
	| {
			readonly subtype: "notification";
			readonly key: string;
			readonly text: string;
			readonly priority: string;
			readonly color?: string;
	  }
	/** A user message Claude Code writes into the transcript for the model: Stop hook feedback. */
	| { readonly subtype: "synthetic_user"; readonly text: string };
