/**
 * Claude Code's `DeferredToolPlaceholder`.
 *
 * Claude Code keeps this declaration in every tool list to hold deferred loading open. It stands
 * for no behavior, so a call must fail rather than do nothing.
 */

import { Type } from "typebox";
import type { ToolDefinition } from "../../extensions/types.ts";
import { CC_TOOL_ERRORS, toolUseError } from "./tool-error.ts";

const placeholderSchema = Type.Object({});

export function createDeferredToolPlaceholderDefinition(): ToolDefinition<typeof placeholderSchema, undefined> {
	return {
		name: "DeferredToolPlaceholder",
		label: "Deferred tool placeholder",
		description:
			"A reserved slot that keeps deferred tool loading active. It is not a real tool and must never be called; call the tool it stands in for instead.",
		parameters: placeholderSchema,
		constrainedSampling: false,
		async execute() {
			return {
				content: [{ type: "text", text: toolUseError(CC_TOOL_ERRORS.placeholderCalled) }],
				details: undefined,
				isError: true,
			};
		},
	};
}
