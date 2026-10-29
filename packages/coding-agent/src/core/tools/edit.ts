import type { AgentTool } from "@earendil-works/pi-agent-core";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { splitBom } from "../../utils/text.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { CC_FILE_STATE_SUFFIX, CC_TOOL_TEXT, toolUseError } from "./cc-text.ts";
import {
	detectLineEnding,
	type Edit,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { normalizeForComparison, type ReadState } from "./read-state.ts";
import { type EditRenderState, editRenderers } from "./renderers/edit.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{},
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead. An empty oldText creates the file with newText.",
		}),
		replaceAll: Type.Optional(Type.Boolean({ description: "Replace every occurrence of oldText" })),
	},
	{},
);

export const editToolSystemPromptContribution = {
	snippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
	guidelines: [
		"Use edit for precise changes (edits[].oldText must match exactly)",
		"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
		"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
		"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
		"An edits[].oldText that matches the file only approximately is not applied. Re-read the file and copy the exact text.",
	],
} as const;

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
};

type SingleEditInput = { oldText: string; newText: string };

function isSingleEditInput(value: unknown): value is SingleEditInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	const edit = value as Record<string, unknown>;
	return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

export interface EditToolDetails {
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	/** Custom operations for file editing. Default: local filesystem */
	operations?: EditOperations;
	/** What the model has read, for the read-before-write checks. */
	readState?: ReadState;
	/** Whether a Read of this absolute path would need approval. Default: never gated. */
	isReadGated?: (absolutePath: string) => boolean;
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as Record<string, unknown>;

	// Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array.
	// Others send a single edit object instead of a one-element edits array.
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) {
				args.edits = parsed;
			} else if (isSingleEditInput(parsed)) {
				args.edits = [parsed];
			}
		} catch {}
	} else if (isSingleEditInput(args.edits)) {
		args.edits = [args.edits];
	}

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
		return args as EditToolInput;
	}

	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[]; replaceAll: boolean } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits, replaceAll: input.replaceAll === true };
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique region of the original file exactly, including whitespace and indentation; a failed match is not retried with normalization. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. An empty oldText creates the file.",
		promptSnippet: editToolSystemPromptContribution.snippet,
		promptGuidelines: [...editToolSystemPromptContribution.guidelines],
		parameters: editSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		renderShell: "self",
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, ctx?: ExtensionContext) {
			const { path, edits, replaceAll } = validateEditInput(input);
			const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);
			const workdir = ctx?.cwd || cwd;

			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();

				const record = options?.readState?.get(absolutePath);
				const raw = await readIfPresent(ops, absolutePath, path);
				throwIfAborted();

				// Both refusals exist to avoid a prompt, so Claude Code raises them only for a path whose
				// Read would need approval. In an auto-allowed workspace it applies the edit.
				const readGated = raw !== undefined && options?.isReadGated?.(absolutePath) === true;
				if (readGated && record === undefined) throw new Error(toolUseError(CC_TOOL_TEXT.editNotRead));
				if (readGated && record !== undefined && normalizeForComparison(raw) !== record.content) {
					throw new Error(toolUseError(CC_TOOL_TEXT.editStale));
				}

				const { bom, text: content } = splitBom(raw ?? "");
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);
				const normalizedEdits = edits.map((edit) => ({
					oldText: normalizeToLF(edit.oldText),
					newText: normalizeToLF(edit.newText),
					rawOld: edit.oldText,
					rawNew: edit.newText,
				}));

				if (normalizedEdits.some((edit) => edit.oldText === edit.newText)) {
					throw new Error(toolUseError(CC_TOOL_TEXT.editNoChanges));
				}

				const creating = normalizedEdits.some((edit) => edit.oldText === "");
				if (creating) {
					if (normalizedEdits.length !== 1) {
						throw new Error(toolUseError(CC_TOOL_TEXT.editFileExists));
					}
					if (normalizedContent.trim() !== "") {
						throw new Error(toolUseError(CC_TOOL_TEXT.editFileExists));
					}
					await ops.writeFile(absolutePath, normalizedEdits[0].rawNew);
					throwIfAborted();
					options?.readState?.record(absolutePath, {
						content: normalizeForComparison(normalizedEdits[0].rawNew),
						partial: false,
					});
					return {
						content: [
							{ type: "text", text: `The file ${path} has been updated successfully.${suffix(raw, record)}` },
						],
						details: undefined,
					};
				}

				if (raw === undefined) throw new Error(toolUseError(CC_TOOL_TEXT.readMissing(workdir)));

				const applied = applyExactEdits(normalizedContent, normalizedEdits, replaceAll);
				throwIfAborted();
				const finalContent = bom + restoreLineEndings(applied.next, originalEnding);
				await ops.writeFile(absolutePath, finalContent);
				throwIfAborted();
				options?.readState?.record(absolutePath, { content: normalizeForComparison(finalContent), partial: false });

				const diffResult = generateDiffString(normalizedContent, applied.next);
				const patch = generateUnifiedPatch(path, normalizedContent, applied.next);
				const wording = replaceAll
					? `The file ${path} has been updated. All occurrences were successfully replaced.`
					: `The file ${path} has been updated successfully.`;
				return {
					content: [{ type: "text", text: `${wording}${suffix(raw, record)}` }],
					details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
				};
			});
		},
		...editRenderers,
	};
}

/**
 * Claude Code appends the file-state suffix when the file's content is in the model's context:
 * it just supplied that content (a new file), or it read the file in this session.
 */
function suffix(raw: string | undefined, record: { content: string } | undefined): string {
	return raw === undefined || record !== undefined ? ` ${CC_FILE_STATE_SUFFIX}` : "";
}

async function readIfPresent(
	ops: EditOperations,
	absolutePath: string,
	displayPath: string,
): Promise<string | undefined> {
	try {
		await ops.access(absolutePath);
		return (await ops.readFile(absolutePath)).toString("utf-8");
	} catch (error) {
		const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
		// A missing file is Claude Code's text. Any other access failure keeps pi's message, so a
		// custom operation that throws still names the cause.
		if (code === "ENOENT") return undefined;
		const detail = code !== undefined ? `Error code: ${code}` : String(error);
		throw new Error(`Could not edit file: ${displayPath}. ${detail}.`);
	}
}

interface NormalizedEdit {
	oldText: string;
	newText: string;
	rawOld: string;
}

/**
 * Exact replacements against the original text. A match that only exists after fuzzy
 * normalization is a miss: Claude Code refuses it, and so does this tool.
 */
function applyExactEdits(content: string, edits: readonly NormalizedEdit[], replaceAll: boolean): { next: string } {
	const spans: Array<{ start: number; end: number; newText: string; rawOld: string }> = [];
	for (const edit of edits) {
		const indexes = indexesOf(content, edit.oldText);
		if (indexes.length === 0) throw new Error(toolUseError(CC_TOOL_TEXT.editNotFound(edit.rawOld)));
		if (indexes.length > 1 && !replaceAll) {
			throw new Error(toolUseError(CC_TOOL_TEXT.editMultipleMatches(indexes.length, edit.rawOld)));
		}
		const used = replaceAll ? indexes : indexes.slice(0, 1);
		for (const start of used)
			spans.push({ start, end: start + edit.oldText.length, newText: edit.newText, rawOld: edit.rawOld });
	}
	spans.sort((left, right) => left.start - right.start);
	for (let i = 1; i < spans.length; i++) {
		if (spans[i - 1].end > spans[i].start) {
			throw new Error(toolUseError("edits overlap. Merge them into one edit or target disjoint regions."));
		}
	}
	let next = "";
	let cursor = 0;
	for (const span of spans) {
		next += content.slice(cursor, span.start) + span.newText;
		cursor = span.end;
	}
	next += content.slice(cursor);
	if (next === content) throw new Error(toolUseError(CC_TOOL_TEXT.editNoChanges));
	return { next };
}

function indexesOf(content: string, text: string): number[] {
	const indexes: number[] = [];
	let index = content.indexOf(text);
	while (index !== -1) {
		indexes.push(index);
		index = content.indexOf(text, index + text.length);
	}
	return indexes;
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
