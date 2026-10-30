import type { AgentTool } from "@earendil-works/pi-agent-core";
import { mkdir as fsMkdir, readFile as fsReadFile, stat as fsStat, writeFile as fsWriteFile } from "fs/promises";
import { basename, dirname } from "path";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { CC_FILE_STATE_SUFFIX, CC_TOOL_TEXT, toolUseError } from "./cc-text.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { isStaleSinceRead, normalizeForComparison, type ReadState, readMtimeMs } from "./read-state.ts";
import { writeRenderers } from "./renderers/write.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export const writeToolSystemPromptContribution = {
	snippet: "Create or overwrite files",
	guidelines: ["Use write only for new files or complete rewrites."],
} as const;

export type WriteToolInput = Static<typeof writeSchema>;

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
	/**
	 * Read existing content, for the prior-read check and Claude Code's created or updated wording.
	 * Without it the prior content is unknown: a write requiring a prior read is refused, and any
	 * other write reports neither created nor updated.
	 */
	readFile?: (absolutePath: string) => Promise<Buffer>;
	stat?: (absolutePath: string) => Promise<{ isFile: () => boolean }>;
	/** Modification time in milliseconds. Without it the content alone decides whether a read went stale. */
	mtimeMs?: (absolutePath: string) => Promise<number>;
}

const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
	readFile: (path) => fsReadFile(path),
	stat: (path) => fsStat(path),
	mtimeMs: async (path) => (await fsStat(path)).mtimeMs,
};

export interface WriteToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteOperations;
	/** What the model has read, for the read-before-write checks. */
	readState?: ReadState;
	/** Whether the model or path requires a prior read. Default: never gated. */
	isReadGated?: (absolutePath: string) => boolean;
	/** True when this session runs as a subagent, which may not write report files. */
	agentContext?: boolean;
}

/** Report filenames a subagent must return as text instead of writing. */
const SUBAGENT_REPORT_NAME = /^(REPORT|SUMMARY|FINDINGS|ANALYSIS).*\.md$/i;

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, undefined> {
	const ops = options?.operations ?? defaultWriteOperations;
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		promptSnippet: writeToolSystemPromptContribution.snippet,
		promptGuidelines: [...writeToolSystemPromptContribution.guidelines],
		parameters: writeSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);
			const dir = dirname(absolutePath);
			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();

				if (options?.agentContext === true && SUBAGENT_REPORT_NAME.test(basename(absolutePath))) {
					throw new Error(toolUseError(CC_TOOL_TEXT.writeReportRefusal));
				}

				const record = options?.readState?.get(absolutePath);
				const gated = options?.isReadGated?.(absolutePath) === true;
				if (ops.readFile === undefined && gated) {
					throw new Error("Write operations must provide readFile to check a file requiring a prior read.");
				}
				const previous =
					ops.readFile === undefined ? undefined : await readIfPresent(ops.readFile, ops.stat, absolutePath);
				throwIfAborted();

				// Older models require a prior read even for an auto-allowed workspace path.
				const readGated = previous !== undefined && gated;
				// A read cut at the token cap is an unfinished view: Write refuses it on every model.
				if (previous !== undefined && (record?.unfinished === true || (readGated && record === undefined)))
					throw new Error(toolUseError(CC_TOOL_TEXT.editNotRead));
				// Claude Code refuses a write over a file that changed since the model read it for every
				// model, with no permission check (`chunk-r5cyd28m.js:44886-44893`): unlike Edit there is
				// no recovery, because the write would discard the on-disk changes.
				if (
					record !== undefined &&
					previous !== undefined &&
					isStaleSinceRead(record, await readMtimeMs(ops.mtimeMs, absolutePath), previous)
				) {
					throw new Error(toolUseError(CC_TOOL_TEXT.editStale));
				}

				// Create parent directories if needed.
				await ops.mkdir(dir);
				throwIfAborted();

				// Write the file contents.
				await ops.writeFile(absolutePath, content);
				throwIfAborted();
				options?.readState?.record(absolutePath, {
					content: normalizeForComparison(content),
					partial: false,
					timestamp: await readMtimeMs(ops.mtimeMs, absolutePath),
				});

				// Claude Code calls it a create when the file did not exist or held nothing.
				const text =
					ops.readFile === undefined
						? `File written successfully at: ${path} ${CC_FILE_STATE_SUFFIX}`
						: previous === undefined || previous === ""
							? `File created successfully at: ${path} ${CC_FILE_STATE_SUFFIX}`
							: `The file ${path} has been updated successfully. ${CC_FILE_STATE_SUFFIX}`;
				return { content: [{ type: "text", text }], details: undefined };
			});
		},
		...writeRenderers,
	};
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}

/** The file's text, or undefined when the path holds no file. Only the given operations touch the file. */
async function readIfPresent(
	readFile: NonNullable<WriteOperations["readFile"]>,
	stat: WriteOperations["stat"],
	absolutePath: string,
): Promise<string | undefined> {
	try {
		if (stat) {
			const stats = await stat(absolutePath);
			if (!stats.isFile()) return undefined;
		}
		return (await readFile(absolutePath)).toString("utf-8");
	} catch {
		return undefined;
	}
}
