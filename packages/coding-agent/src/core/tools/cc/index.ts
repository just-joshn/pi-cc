/**
 * The Claude Code tool registry: the five declarations pi-cc puts in front of the model, in the
 * order Claude Code 2.1.312 declares them, plus the shared names, errors and read state.
 */

import type { ToolDefinition } from "../../extensions/types.ts";
import type { BashToolOptions } from "../bash.ts";
import type { EditToolOptions } from "../edit.ts";
import type { ReadToolOptions } from "../read.ts";
import type { WriteToolOptions } from "../write.ts";
import { createCcBashToolDefinition } from "./bash.ts";
import { createCcEditToolDefinition } from "./edit.ts";
import { CC_DECLARED_ORDER, type CcToolName } from "./names.ts";
import { createDeferredToolPlaceholderDefinition } from "./placeholder.ts";
import { createCcReadToolDefinition } from "./read.ts";
import type { ReadState } from "./read-state.ts";
import { createCcWriteToolDefinition } from "./write.ts";

export interface CcToolOptions {
	readState: ReadState;
	read?: ReadToolOptions;
	edit?: EditToolOptions;
	write?: WriteToolOptions;
	bash?: BashToolOptions;
	/** Whether a Read of this absolute path would need approval. Default: never gated. */
	isReadGated?: (absolutePath: string) => boolean;
}

/**
 * One Claude Code declaration.
 *
 * Claude Code's measured requests carry no `strict` tool field and do not coerce arguments. pi's
 * strict conversion rewrites an optional property into a required, nullable `anyOf` and adds
 * `additionalProperties`, and its argument validation turns a number into a string; either would
 * change what the model sees, so the registry opts out of both.
 */
export function createCcToolDefinition(
	name: CcToolName,
	cwd: string,
	options: CcToolOptions,
): ToolDefinition<any, any, any> {
	switch (name) {
		case "Bash":
			return withCcRequestBehavior(createCcBashToolDefinition(cwd, options.bash));
		case "Edit":
			return withCcRequestBehavior(createCcEditToolDefinition(cwd, options));
		case "Read":
			return withCcRequestBehavior(createCcReadToolDefinition(cwd, options));
		case "DeferredToolPlaceholder":
			return withCcRequestBehavior(createDeferredToolPlaceholderDefinition());
		case "Write":
			return withCcRequestBehavior(createCcWriteToolDefinition(cwd, options));
	}
}

/** Emit the schema as written and report type mismatches instead of coercing, as Claude Code does. */
function withCcRequestBehavior(definition: ToolDefinition<any, any, any>): ToolDefinition<any, any, any> {
	return { ...definition, constrainedSampling: false, coerceArguments: false };
}

/** All five Claude Code declarations, in `CC_DECLARED_ORDER`. */
export function createCcToolDefinitions(cwd: string, options: CcToolOptions): ToolDefinition<any, any, any>[] {
	return CC_DECLARED_ORDER.map((name) => createCcToolDefinition(name, cwd, options));
}

export { type CcBashOptions, createCcBashToolDefinition } from "./bash.ts";
export { CC_FILE_STATE_SUFFIX, type CcEditOptions, createCcEditToolDefinition } from "./edit.ts";
export { CC_DECLARED_ORDER, type CcToolName, canonicalToolName, piTwinName } from "./names.ts";
export { createDeferredToolPlaceholderDefinition } from "./placeholder.ts";
export { type CcReadOptions, createCcReadToolDefinition } from "./read.ts";
export { createReadState, type ReadRecord, type ReadState } from "./read-state.ts";
export { CC_TOOL_ERRORS, toolUseError, unknownToolResult } from "./tool-error.ts";
export { type CcWriteOptions, createCcWriteToolDefinition } from "./write.ts";
