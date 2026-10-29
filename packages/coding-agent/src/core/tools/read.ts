import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, ModelImageResizeOptions, TextContent } from "@earendil-works/pi-ai";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, stat as fsStat } from "fs/promises";
import { extname } from "path";
import { type Static, Type } from "typebox";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { CC_READ_MAX_BYTES, CC_READ_MAX_TOKENS, CC_TOOL_TEXT, formatCcSize, toolUseError } from "./cc-text.ts";
import { resolveReadPathAsync } from "./path-utils.ts";
import { normalizeForComparison, type ReadState } from "./read-state.ts";
import { readRenderers } from "./renderers/read.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import type { TruncationResult } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	allowLarge: Type.Optional(Type.Boolean({ description: "Read a file larger than the size limit" })),
});

export const readToolSystemPromptContribution = {
	snippet: "Read file contents",
	guidelines: [
		"Use read to examine files instead of cat or sed.",
		"Use offset and limit to page through a file that is too large to read in one call.",
	],
} as const;

export type ReadToolInput = Static<typeof readSchema>;

/**
 * Result for programmatic callers such as codemode scripts: the text for text files, and an image
 * block for images that codemode's `image()` accepts. `note` is the text that goes with the image,
 * such as resize hints. Property descriptions are left out so the type stays on one line in tool
 * descriptions.
 */
const readOutputSchema = Type.Union([
	Type.String(),
	Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String(), note: Type.String() }),
]);

export type ReadToolOutput = Static<typeof readOutputSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
	/**
	 * The line number the first returned line is displayed with. Claude Code numbers every returned
	 * line from the requested offset, and its model-facing text is written from these numbers, so a
	 * result that carries no content (a warning, a refusal) leaves this unset.
	 */
	firstLineNumber?: number;
}

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

export interface ReadToolOptions {
	/** Whether to auto-resize images. Default: true */
	autoResizeImages?: boolean;
	/** Fallback resize profile when the execution context has no model metadata. */
	resizeOptions?: ModelImageResizeOptions;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
	/** Records what each successful read returned, for the Edit and Write read-state checks. */
	readState?: ReadState;
}

/** The image block and its note, or the text for text files and images that could not be processed. */
function toReadOutput(content: (TextContent | ImageContent)[]): ReadToolOutput {
	const text = content.find((block) => block.type === "text")?.text ?? "";
	const image = content.find((block) => block.type === "image");
	return image ? { type: "image", data: image.data, mimeType: image.mimeType, note: text } : text;
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const fallbackResizeOptions = options?.resizeOptions;
	const ops = options?.operations ?? defaultReadOperations;
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. A file larger than ${CC_READ_MAX_BYTES / 1024}KB is refused unless allowLarge is set. Text output is capped at about ${CC_READ_MAX_TOKENS} tokens; page through a larger file with offset and limit.`,
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		parameters: readSchema,
		outputSchema: readOutputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, offset, limit, allowLarge }: { path: string; offset?: number; limit?: number; allowLarge?: boolean },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			return new Promise<{
				content: (TextContent | ImageContent)[];
				details: ReadToolDetails | undefined;
				rawText: string | undefined;
			}>((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				let aborted = false;
				const onAbort = () => {
					aborted = true;
					reject(new Error("Operation aborted"));
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const absolutePath = await resolveReadPathAsync(path, ctx?.cwd || cwd);
						if (aborted) return;
						await assertReadableFile(absolutePath, ctx?.cwd || cwd, ops);
						if (aborted) return;
						const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
						let content: (TextContent | ImageContent)[];
						let details: ReadToolDetails | undefined;
						/** The file's text without Claude Code's line numbers, for programmatic callers. */
						let rawText: string | undefined;
						const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
						if (mimeType) {
							// Read image as binary.
							const buffer = await ops.readFile(absolutePath);
							const processed = await processImage(buffer, mimeType, {
								autoResizeImages,
								resizeOptions: ctx?.model?.inputLimits?.images?.resize ?? fallbackResizeOptions,
							});
							if (!processed.ok) {
								let textNote = `Read image file [${mimeType}]\n${processed.message}`;
								if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
								content = [{ type: "text", text: textNote }];
							} else {
								let textNote = `Read image file [${processed.mimeType}]`;
								if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
								if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
								content = [
									{ type: "text", text: textNote },
									{ type: "image", data: processed.data, mimeType: processed.mimeType },
								];
							}
						} else {
							// Read text content. Claude Code numbers every line it returns and keeps the numbers
							// out of the stored content, so the result carries the text and its first line
							// number, and the model boundary renders the numbered form.
							const buffer = await ops.readFile(absolutePath);
							if (looksBinary(buffer)) {
								throw new Error(toolUseError(CC_TOOL_TEXT.readBinary(extname(absolutePath).toLowerCase())));
							}
							if (limit === undefined && !allowLarge && buffer.byteLength > CC_READ_MAX_BYTES) {
								throw new Error(
									CC_TOOL_TEXT.readTooLarge(formatCcSize(buffer.byteLength), formatCcSize(CC_READ_MAX_BYTES)),
								);
							}
							const fileContent = normalizeForComparison(buffer.toString("utf-8"));
							const allLines = fileContent === "" ? [] : fileContent.split("\n");
							const totalLines = allLines.length;
							rawText = "";
							if (totalLines === 0) {
								content = [{ type: "text", text: CC_TOOL_TEXT.readEmptyFile }];
							} else {
								// A negative offset reads from the start, and offset 0 numbers the first line 0.
								const firstLineNumber = offset === undefined || offset < 0 ? 1 : offset;
								const startIndex = firstLineNumber === 0 ? 0 : firstLineNumber - 1;
								if (startIndex >= totalLines) {
									content = [
										{ type: "text", text: CC_TOOL_TEXT.readShortOffset(firstLineNumber, totalLines) },
									];
								} else {
									// Claude Code reads to the end of the file when no limit, or a limit of 0, is asked for.
									const lineLimit = limit === undefined || limit === 0 ? undefined : limit;
									const endIndex =
										lineLimit === undefined ? totalLines : Math.min(startIndex + lineLimit, totalLines);
									const selected = allLines.slice(startIndex, endIndex);
									// allowLarge lifts the cap entirely: Claude Code then returns what fits in context.
									const capped =
										lineLimit === undefined && !allowLarge ? capReadTokens(selected, totalLines) : undefined;
									const shown = capped?.lines ?? selected;
									rawText = shown.join("\n");
									const numbered = numberLines(rawText, firstLineNumber);
									content = [
										{
											type: "text",
											text:
												capped === undefined
													? numbered
													: `${numbered}\n\n${partialViewNotice(path, shown.length, totalLines)}`,
										},
									];
									details = {
										firstLineNumber,
										...(capped === undefined ? {} : { truncation: capped.truncation }),
									};
								}
							}
							const readState = options?.readState;
							if (readState !== undefined && details?.firstLineNumber !== undefined) {
								const wholeFile =
									details.truncation === undefined &&
									(limit === undefined || limit === 0) &&
									details.firstLineNumber <= 1;
								readState.record(absolutePath, { content: fileContent, partial: !wholeFile });
							}
						}

						if (aborted) return;
						signal?.removeEventListener("abort", onAbort);
						resolve({ content, details, rawText });
					} catch (error: any) {
						signal?.removeEventListener("abort", onAbort);
						if (!aborted) reject(error);
					}
				})();
			}).then((result) => ({
				content: result.content,
				details: result.details,
				structuredContent: result.rawText ?? toReadOutput(result.content),
			}));
		},
		...readRenderers,
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}

/**
 * Claude Code answers a missing path and a directory with its own text, so both are decided
 * before a read turns them into an OS error. Custom read operations may serve paths this process
 * cannot stat, so a failed stat falls back to the operations' own access check.
 */
async function assertReadableFile(absolutePath: string, cwd: string, ops: ReadOperations): Promise<void> {
	let stats: Awaited<ReturnType<typeof fsStat>> | undefined;
	try {
		stats = await fsStat(absolutePath);
	} catch {
		stats = undefined;
	}
	if (stats === undefined) {
		try {
			await ops.access(absolutePath);
		} catch {
			throw new Error(CC_TOOL_TEXT.readMissing(cwd));
		}
		return;
	}
	if (stats.isDirectory()) throw new Error(CC_TOOL_TEXT.readDirectory(absolutePath));
}

/** `<n>\t<line>` for every line, numbers unpadded, a trailing newline showing as a final empty line. */
function numberLines(text: string, firstLineNumber: number): string {
	return text
		.split("\n")
		.map((line, index) => `${firstLineNumber + index}\t${line.endsWith("\r") ? line.slice(0, -1) : line}`)
		.join("\n");
}

/**
 * Claude Code reports a capped read to the model as a partial view. It sends that notice as its own
 * system message; this build appends the same sentence to the read result instead, because a
 * mid-transcript system message is a transport concern this unit does not own.
 */
function partialViewNotice(path: string, shownLines: number, totalLines: number): string {
	return `[Truncated: PARTIAL view — ${path}: showing lines 1-${shownLines} of ${totalLines} total. Call Read with offset=${shownLines + 1} limit=${shownLines} for the next page. Do NOT answer from this page alone if the answer may be further in the file.]`;
}

/** A NUL byte in the first 8KB is Claude Code's reason to call a file binary. */
function looksBinary(buffer: Buffer): boolean {
	return buffer.subarray(0, 8192).includes(0);
}

/**
 * Cap the returned lines at Claude Code's token budget, keeping whole lines. The caller renders
 * the partial-view notice, so the truncation facts go in `details`.
 */
function capReadTokens(
	lines: readonly string[],
	totalLines: number,
): { lines: string[]; truncation: TruncationResult } | undefined {
	const maxBytes = CC_READ_MAX_TOKENS * 4;
	let bytes = 0;
	let shown = 0;
	for (const line of lines) {
		const next = bytes + Buffer.byteLength(line, "utf-8") + 1;
		if (next > maxBytes) break;
		bytes = next;
		shown++;
	}
	if (shown === lines.length) return undefined;
	const kept = lines.slice(0, Math.max(1, shown));
	const outputBytes = Math.min(bytes, maxBytes);
	return {
		lines: kept,
		truncation: {
			content: kept.join("\n"),
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes: lines.reduce((sum, line) => sum + Buffer.byteLength(line, "utf-8") + 1, 0),
			outputLines: kept.length,
			outputBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines: kept.length,
			maxBytes,
		},
	};
}
