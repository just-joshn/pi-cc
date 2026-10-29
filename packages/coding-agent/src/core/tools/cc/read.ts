/**
 * Claude Code's `Read` tool.
 *
 * Execution is pi's read, so offset, limit, truncation and image handling stay pi's. The result
 * text is Claude Code's: every line prefixed with its number and a tab, and no truncation notice.
 */

import type { Stats } from "node:fs";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import type { TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ToolDefinition } from "../../extensions/types.ts";
import { resolveReadPathAsync } from "../path-utils.ts";
import { createReadToolDefinition, type ReadToolDetails, type ReadToolOptions } from "../read.ts";
import { readRenderers } from "../renderers/read.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../truncate.ts";
import type { ReadState } from "./read-state.ts";
import { toolUseError } from "./tool-error.ts";

const ccReadSchema = Type.Object({
	file_path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER,
			description: "Line number to start reading from, 1-indexed. Default: 1",
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			exclusiveMinimum: 0,
			maximum: Number.MAX_SAFE_INTEGER,
			description: "Maximum number of lines to return",
		}),
	),
	pages: Type.Optional(
		Type.String({
			description:
				'PDF page range such as "1-5". This build cannot render PDF pages, so the argument is accepted and ignored.',
		}),
	),
	allow_large: Type.Optional(
		Type.Boolean({
			description:
				"Read a file larger than the default size limit. This build always applies its own line and byte truncation, so the argument is accepted and ignored.",
		}),
	),
});

export interface CcReadOptions {
	readState: ReadState;
	/** Passed through to pi's read, for example custom file operations. */
	read?: ReadToolOptions;
}

export function createCcReadToolDefinition(
	cwd: string,
	options: CcReadOptions,
): ToolDefinition<typeof ccReadSchema, ReadToolDetails | undefined> {
	const readState = options.readState;
	const piRead = createReadToolDefinition(cwd, options.read);
	return {
		name: "Read",
		label: "Read",
		description: `Read a file and return it as numbered lines (\`<n>\\t<line>\`, numbers unpadded). Text files are truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB, whichever is hit first; page through a larger file with offset and limit, and keep calling with the next offset until the whole file has been read. Images come back as an attachment instead of text. Read a file before editing or overwriting it.`,
		promptSnippet: "Read file contents as numbered lines",
		promptGuidelines: [
			"Use Read to examine files instead of cat or sed.",
			"Read a file before editing or overwriting it, so its current state is in context.",
			"Use offset and limit to page through a file too large to read in one call.",
		],
		parameters: ccReadSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_toolCallId, { file_path, offset, limit }, signal, onUpdate, ctx) {
			const callCwd = ctx?.cwd || cwd;
			const absolutePath = await resolveReadPathAsync(file_path, callCwd);
			await assertReadableFile(absolutePath, callCwd);

			let result: Awaited<ReturnType<typeof piRead.execute>>;
			try {
				result = await piRead.execute("cc-read", { path: file_path, offset, limit }, signal, onUpdate, ctx);
			} catch (error) {
				throw new Error(toolUseError(error instanceof Error ? error.message : String(error)));
			}

			const textBlock = result.content.find((block): block is TextContent => block.type === "text");
			if (textBlock === undefined || result.content.some((block) => block.type === "image")) {
				return result;
			}

			await readState.record(absolutePath, (await fsReadFile(absolutePath)).toString("utf-8"));
			return {
				content: [{ type: "text", text: numberLines(stripTruncationNotice(textBlock.text), startLine(offset)) }],
				details: result.details,
			};
		},
		...readRenderers,
	};
}

/**
 * Claude Code answers a missing file and a directory path with its own text, so the check happens
 * before pi's read turns them into an OS error.
 */
async function assertReadableFile(absolutePath: string, cwd: string): Promise<void> {
	let stats: Stats;
	try {
		stats = await fsStat(absolutePath);
	} catch {
		throw new Error(toolUseError(`File does not exist. Note: your current working directory is ${cwd}.`));
	}
	if (stats.isDirectory()) {
		throw new Error(toolUseError(`EISDIR: illegal operation on a directory, read '${absolutePath}'`));
	}
}

function startLine(offset: number | undefined): number {
	return offset !== undefined && offset > 0 ? offset : 1;
}

/** pi ends a truncated read with a continuation notice; Claude Code's numbered lines carry none. */
const PI_TRUNCATION_NOTICE =
	/\n\n\[(?:Showing lines \d+-\d+ of \d+(?: \([^)]*\))?|\d+ more lines in file)\. Use offset=\d+ to continue\.\]$/;

function stripTruncationNotice(text: string): string {
	return text.replace(PI_TRUNCATION_NOTICE, "");
}

function numberLines(text: string, firstLine: number): string {
	return text
		.split("\n")
		.map((line, index) => `${firstLine + index}\t${line}`)
		.join("\n");
}
