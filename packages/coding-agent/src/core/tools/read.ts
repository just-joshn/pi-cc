import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, ModelImageResizeOptions, TextContent } from "@earendil-works/pi-ai";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, stat as fsStat } from "fs/promises";
import { extname } from "path";
import { type Static, Type } from "typebox";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import {
	CC_READ_MAX_BYTES,
	CC_READ_MAX_TOKENS,
	CC_TOOL_TEXT,
	estimateTextTokens,
	formatCcSize,
	toolUseError,
} from "./cc-text.ts";
import { resolveReadPathAsync } from "./path-utils.ts";
import { normalizeForComparison, type ReadState, readMtimeMs } from "./read-state.ts";
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
	/**
	 * Claude Code's partial-view notice. The model boundary sends it as the following system message,
	 * or inside the result on a model that takes no mid-conversation system messages.
	 */
	ccNotice?: string;
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
	/** Modification time in milliseconds, recorded so Edit and Write can tell a changed file from a touched one. */
	mtimeMs?: (absolutePath: string) => Promise<number>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
	mtimeMs: async (path) => (await fsStat(path)).mtimeMs,
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
	/** Tokens of context left for this turn's reads, or undefined when unknown. */
	contextRoomTokens?: () => number | undefined;
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
							const room = options?.contextRoomTokens?.();
							const limits = readLimits(room, allowLarge === true);
							if (limit === undefined && buffer.byteLength > limits.maxBytes) {
								throw new Error(
									CC_TOOL_TEXT.readTooLarge(
										formatCcSize(buffer.byteLength),
										formatCcSize(limits.maxBytes),
										largeReadAdvice(room, allowLarge === true, { bytes: buffer.byteLength }),
									),
								);
							}
							const fileContent = normalizeForComparison(buffer.toString("utf-8"));
							const allLines = fileContent === "" ? [] : fileContent.split("\n");
							const totalLines = allLines.length;
							rawText = "";
							let selectedCount = 0;
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
									const lineLimit = limit === undefined || limit <= 0 ? undefined : limit;
									const endIndex =
										lineLimit === undefined ? totalLines : Math.min(startIndex + lineLimit, totalLines);
									const selected = allLines.slice(startIndex, endIndex);
									selectedCount = selected.length;
									const selectedText = selected.join("\n");
									const tokens = estimateTextTokens(selectedText);
									const fromStart = offset === undefined || offset <= 1;
									const wholeFile = fromStart && lineLimit === undefined;
									// A bounded or offset read over the cap is refused. A whole-file read from the start
									// is cut to the default cap and announced; allowLarge raises the cap to the context
									// left, and a file beyond even that is cut to the default cap as well (measured).
									if (tokens > limits.maxTokens && !wholeFile) {
										throw new Error(
											CC_TOOL_TEXT.readTooManyTokens(
												tokens,
												CC_READ_MAX_TOKENS,
												largeReadAdvice(room, allowLarge === true, { tokens }),
											),
										);
									}
									const kept =
										tokens > limits.maxTokens ? keepLinesWithinTokenCap(selected, tokens) : selected;
									rawText = kept.join("\n");
									const numbered = numberLines(rawText, firstLineNumber);
									content = [{ type: "text", text: numbered }];
									const truncated = kept.length !== selected.length;
									details = {
										firstLineNumber,
										...(truncated
											? {
													ccNotice: CC_TOOL_TEXT.readPartialNotice(
														absolutePath,
														kept.length,
														totalLines,
														allowLarge && room !== undefined
															? CC_TOOL_TEXT.readPartialSizeOverRoom(tokens, room)
															: CC_TOOL_TEXT.readPartialSize(tokens),
														largeReadAdvice(room, allowLarge === true, { tokens }),
													),
													truncation: {
														content: rawText,
														truncated: true,
														truncatedBy: "bytes" as const,
														totalLines,
														totalBytes: Buffer.byteLength(selectedText, "utf-8"),
														outputLines: kept.length,
														outputBytes: Buffer.byteLength(rawText, "utf-8"),
														lastLinePartial: false,
														firstLineExceedsLimit: false,
														maxLines: kept.length,
														maxBytes: CC_READ_MAX_TOKENS * 4,
													},
												}
											: {}),
									};
								}
							}
							const readState = options?.readState;
							if (readState !== undefined && details?.firstLineNumber !== undefined) {
								// Claude Code's full-read test (`PR`): from the first line, nothing cut, and no
								// limit unless the file ended before it.
								const wholeFile =
									details.truncation === undefined &&
									(offset ?? 1) <= 1 &&
									(limit === undefined || selectedCount < limit);
								readState.record(absolutePath, {
									content: fileContent,
									partial: !wholeFile,
									timestamp: await readMtimeMs(ops.mtimeMs, absolutePath),
								});
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

/**
 * Claude Code's caps for one read. allowLarge raises them to the context left this turn when that
 * is known and larger than the default; with no session to ask, it lifts them.
 */
function readLimits(room: number | undefined, allowLarge: boolean): { maxBytes: number; maxTokens: number } {
	if (!allowLarge) return { maxBytes: CC_READ_MAX_BYTES, maxTokens: CC_READ_MAX_TOKENS };
	if (room === undefined) return { maxBytes: Number.POSITIVE_INFINITY, maxTokens: Number.POSITIVE_INFINITY };
	if (room <= CC_READ_MAX_TOKENS) return { maxBytes: CC_READ_MAX_BYTES, maxTokens: CC_READ_MAX_TOKENS };
	return { maxBytes: Math.max(CC_READ_MAX_BYTES, room * BYTES_PER_TOKEN * 3), maxTokens: room };
}

const BYTES_PER_TOKEN = 4;

/** The refusal's closing advice: retry with allow_large only when the content would fit the room. */
function largeReadAdvice(
	room: number | undefined,
	optedIn: boolean,
	size: { bytes?: number; tokens?: number },
): string {
	if (room === undefined) return optedIn ? CC_TOOL_TEXT.readNoRoomAdvice : CC_TOOL_TEXT.readRetryAdvice;
	if (optedIn) return CC_TOOL_TEXT.readNoRoomAdvice;
	const raised = readLimits(room, true);
	if (raised.maxTokens === CC_READ_MAX_TOKENS) return CC_TOOL_TEXT.readNoRoomAdvice;
	const fits =
		(size.bytes === undefined || size.bytes <= raised.maxBytes) &&
		(size.tokens === undefined || size.tokens <= raised.maxTokens);
	return fits ? CC_TOOL_TEXT.readRetryAdvice : CC_TOOL_TEXT.readNoRoomAdvice;
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

/** A NUL byte in the first 8KB is Claude Code's reason to call a file binary. */
function looksBinary(buffer: Buffer): boolean {
	return buffer.subarray(0, 8192).includes(0);
}

/**
 * Keep a prefix of lines whose estimated tokens fit the cap. The first cut is 85% of the
 * proportional share, then each retry drops 30%, matching the shrink Claude Code uses after
 * its tokenizer refuses the whole file. The count here is {@link estimateTextTokens}, not that
 * tokenizer, so the line count will not match a count_tokens reply.
 */
function keepLinesWithinTokenCap(lines: readonly string[], tokenCount: number): string[] {
	let count = Math.max(
		1,
		Math.min(lines.length, Math.floor(((lines.length * CC_READ_MAX_TOKENS) / Math.max(1, tokenCount)) * 0.85)),
	);
	let kept = lines.slice(0, count).join("\n");
	for (let attempt = 0; attempt < 6 && estimateTextTokens(kept) > CC_READ_MAX_TOKENS && count > 1; attempt++) {
		count = Math.max(1, Math.floor(count * 0.7));
		kept = lines.slice(0, count).join("\n");
	}
	return lines.slice(0, count);
}
