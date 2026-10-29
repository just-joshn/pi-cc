/**
 * Claude Code's `Write` tool.
 *
 * Written through pi's file mutation queue and parent-directory creation, so it serializes against
 * pi's own file tools. The created and updated result text is Claude Code's.
 */

import type { Stats } from "node:fs";
import { mkdir as fsMkdir, stat as fsStat, writeFile as fsWriteFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "../../extensions/types.ts";
import { withFileMutationQueue } from "../file-mutation-queue.ts";
import { resolveToCwd } from "../path-utils.ts";
import { writeRenderers } from "../renderers/write.ts";
import type { WriteToolOptions } from "../write.ts";
import { CC_FILE_STATE_SUFFIX } from "./edit.ts";
import type { ReadState } from "./read-state.ts";
import { CC_TOOL_ERRORS, toolUseError } from "./tool-error.ts";

const ccWriteSchema = Type.Object({
	file_path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

/** Report filenames a subagent must return as text instead of writing. */
const SUBAGENT_REPORT_NAME = /^(REPORT|SUMMARY|FINDINGS|ANALYSIS).*\.md$/i;

export interface CcWriteOptions {
	readState: ReadState;
	/** Passed through for pi's pluggable file operations. */
	write?: WriteToolOptions;
	/** Whether a Read of this absolute path would need approval. Default: never gated. */
	isReadGated?: (absolutePath: string) => boolean;
	/** True when the session runs as a subagent, which may not write report files. */
	agentContext?: boolean;
}

export function createCcWriteToolDefinition(
	cwd: string,
	options: CcWriteOptions,
): ToolDefinition<typeof ccWriteSchema, undefined> {
	const writeFile =
		options.write?.operations?.writeFile ?? ((path: string, content: string) => fsWriteFile(path, content, "utf-8"));
	const mkdir =
		options.write?.operations?.mkdir ?? ((dir: string) => fsMkdir(dir, { recursive: true }).then(() => {}));

	return {
		name: "Write",
		label: "Write",
		description:
			"Write content to a file, creating it if it does not exist and overwriting it if it does. Parent directories are created as needed. Read an existing file before you overwrite it.",
		promptSnippet: "Create or overwrite a file",
		promptGuidelines: [
			"Use Write only for a new file or a complete rewrite.",
			"Read an existing file before you overwrite it.",
		],
		parameters: ccWriteSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_toolCallId, { file_path, content }, signal, _onUpdate, ctx) {
			const absolutePath = resolveToCwd(file_path, ctx?.cwd || cwd);

			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort listener: that would release the mutation queue while an
				// in-flight filesystem operation may still finish. Check after each await instead.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();

				if (options.agentContext === true && SUBAGENT_REPORT_NAME.test(basename(absolutePath))) {
					throw new Error(toolUseError(CC_TOOL_ERRORS.reportFilename));
				}

				const record = options.readState.get(absolutePath);
				const stats = await statOrUndefined(absolutePath);
				throwIfAborted();

				// Claude Code gates on paths whose Read would need approval, and never gates a new file.
				if (stats !== undefined && record === undefined && options.isReadGated?.(absolutePath) === true) {
					throw new Error(toolUseError(CC_TOOL_ERRORS.notRead));
				}
				if (record !== undefined && stats !== undefined && Math.floor(stats.mtimeMs) > Math.floor(record.mtimeMs)) {
					throw new Error(toolUseError(CC_TOOL_ERRORS.staleRead));
				}

				await mkdir(dirname(absolutePath));
				throwIfAborted();
				await writeFile(absolutePath, content);
				throwIfAborted();
				await options.readState.record(absolutePath, content);

				const text =
					stats === undefined
						? `File created successfully at: ${file_path} ${CC_FILE_STATE_SUFFIX}`
						: `The file ${file_path} has been updated successfully. ${CC_FILE_STATE_SUFFIX}`;
				return { content: [{ type: "text", text }], details: undefined };
			});
		},
		...writeRenderers,
	};
}

async function statOrUndefined(absolutePath: string): Promise<Stats | undefined> {
	try {
		return await fsStat(absolutePath);
	} catch {
		return undefined;
	}
}
