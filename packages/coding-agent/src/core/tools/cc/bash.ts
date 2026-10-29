/**
 * Claude Code's `Bash` tool.
 *
 * The schema is Claude Code's, including a timeout in milliseconds. Execution is pi's bash, so
 * process handling, output accumulation and truncation stay pi's; only the timeout is converted.
 */

import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../extensions/types.ts";
import { type BashRenderState, type BashToolDetails, type BashToolOptions, createBashToolDefinition } from "../bash.ts";
import { createShellRenderers } from "../renderers/bash.ts";

const ccBashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (optional, no default timeout)" })),
	description: Type.Optional(Type.String({ description: "What the command does, in one short sentence" })),
	run_in_background: Type.Optional(Type.Boolean({ description: "Run the command without waiting for it to finish" })),
	dangerouslyDisableSandbox: Type.Optional(
		Type.Boolean({ description: "Run without the sandbox when the environment provides one" }),
	),
});

export type CcBashInput = Static<typeof ccBashSchema>;

export type CcBashOptions = BashToolOptions;

export function createCcBashToolDefinition(
	cwd: string,
	options?: CcBashOptions,
): ToolDefinition<typeof ccBashSchema, BashToolDetails | undefined, BashRenderState> {
	const piBash = createBashToolDefinition(cwd, options);
	return {
		name: "Bash",
		label: "Bash",
		description: "Run a shell command in the working directory and return its combined output.",
		promptSnippet: "Run shell commands",
		promptGuidelines: [
			"Use Bash to inspect and change the workspace; the timeout is in milliseconds.",
			"You can inspect PI_* environment variables for current model and session details.",
		],
		parameters: ccBashSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		execute(toolCallId, { command, timeout }, signal, onUpdate, ctx) {
			return piBash.execute(
				toolCallId,
				{ command, timeout: timeout === undefined ? undefined : timeout / 1000 },
				signal,
				onUpdate,
				ctx,
			);
		},
		...createShellRenderers("$"),
	};
}
