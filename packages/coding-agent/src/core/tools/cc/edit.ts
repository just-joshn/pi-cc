/**
 * Claude Code's `Edit` tool.
 *
 * Matching and replacement go through pi's edit-diff machinery and pi's file mutation queue, so
 * fuzzy matching, BOM handling and line endings stay pi's. The result and refusal text is Claude
 * Code's.
 */

import type { Stats } from "node:fs";
import { readFile as fsReadFile, stat as fsStat, writeFile as fsWriteFile } from "node:fs/promises";
import { Type } from "typebox";
import { splitBom } from "../../../utils/text.ts";
import type { ToolDefinition } from "../../extensions/types.ts";
import type { EditToolDetails, EditToolOptions } from "../edit.ts";
import {
	applyReplacementsPreservingUnchangedLines,
	detectLineEnding,
	fuzzyFindText,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
} from "../edit-diff.ts";
import { withFileMutationQueue } from "../file-mutation-queue.ts";
import { resolveToCwd } from "../path-utils.ts";
import { type EditRenderState, editRenderers } from "../renderers/edit.ts";
import type { ReadState } from "./read-state.ts";
import { CC_TOOL_ERRORS, toolUseError } from "./tool-error.ts";

const ccEditSchema = Type.Object({
	file_path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	old_string: Type.String({
		description:
			"Exact text to replace, including whitespace. Must be unique in the file unless replace_all is true. Empty to create the file.",
	}),
	new_string: Type.String({ description: "Replacement text" }),
	replace_all: Type.Optional(Type.Boolean({ default: false, description: "Replace every occurrence of old_string" })),
});

/** The suffix Claude Code appends to a successful Edit or Write result. */
export const CC_FILE_STATE_SUFFIX = "(file state is current in your context — no need to Read it back)";

export interface CcEditOptions {
	readState: ReadState;
	/** Passed through for pi's pluggable file operations. */
	edit?: EditToolOptions;
	/** Whether a Read of this absolute path would need approval. Default: never gated. */
	isReadGated?: (absolutePath: string) => boolean;
}

export function createCcEditToolDefinition(
	cwd: string,
	options: CcEditOptions,
): ToolDefinition<typeof ccEditSchema, EditToolDetails | undefined, EditRenderState> {
	const readFile = options.edit?.operations?.readFile ?? ((path: string) => fsReadFile(path));
	const writeFile =
		options.edit?.operations?.writeFile ?? ((path: string, content: string) => fsWriteFile(path, content, "utf-8"));

	return {
		name: "Edit",
		label: "Edit",
		description:
			"Replace exact text in one file. old_string must match the file byte for byte, including whitespace and newlines, and must occur exactly once unless replace_all is true. Pass an empty old_string to create a file. Read a file before you edit it.",
		promptSnippet: "Replace exact text in a file",
		promptGuidelines: [
			"Read a file before you edit it.",
			"Keep old_string as small as possible while it stays unique in the file, and set replace_all to true to replace every occurrence.",
			"Pass an empty old_string to create a file that does not exist yet.",
			"Use Write instead when the whole file changes.",
		],
		parameters: ccEditSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		renderShell: "self",
		async execute(_toolCallId, { file_path, old_string, new_string, replace_all }, signal, _onUpdate, ctx) {
			const absolutePath = resolveToCwd(file_path, ctx?.cwd || cwd);
			const replaceAll = replace_all === true;

			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort listener: that would release the mutation queue while an
				// in-flight filesystem operation may still finish. Check after each await instead.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();

				if (old_string === new_string) {
					throw new Error(toolUseError(CC_TOOL_ERRORS.noChanges));
				}

				const record = options.readState.get(absolutePath);
				const stats = await statOrUndefined(absolutePath);
				throwIfAborted();

				// Claude Code gates on paths whose Read would need approval, and only for a file that already exists.
				if (stats !== undefined && record === undefined && options.isReadGated?.(absolutePath) === true) {
					throw new Error(toolUseError(CC_TOOL_ERRORS.notRead));
				}
				if (record !== undefined && stats !== undefined && Math.floor(stats.mtimeMs) > Math.floor(record.mtimeMs)) {
					throw new Error(toolUseError(CC_TOOL_ERRORS.staleRead));
				}

				if (old_string === "") {
					const existing = stats === undefined ? "" : (await readFile(absolutePath)).toString("utf-8");
					throwIfAborted();
					if (existing.trim() !== "") {
						throw new Error(toolUseError(CC_TOOL_ERRORS.fileExists));
					}
					await writeFile(absolutePath, new_string);
					throwIfAborted();
					await options.readState.record(absolutePath, new_string);
					return {
						content: [
							{
								type: "text",
								text: `The file ${file_path} has been updated successfully. ${CC_FILE_STATE_SUFFIX}`,
							},
						],
						details: undefined,
					};
				}

				if (stats === undefined) {
					throw new Error(toolUseError(CC_TOOL_ERRORS.notFound(old_string)));
				}

				const raw = (await readFile(absolutePath)).toString("utf-8");
				throwIfAborted();

				// Strip the BOM and normalize line endings before matching, as pi's edit does: the model
				// never sends an invisible BOM and may write either ending.
				const { bom, text } = splitBom(raw);
				const originalEnding = detectLineEnding(text);
				const content = normalizeToLF(text);
				const replacement = replaceText(content, normalizeToLF(old_string), normalizeToLF(new_string), replaceAll);
				throwIfAborted();

				if (replacement.kind === "notFound") {
					throw new Error(toolUseError(CC_TOOL_ERRORS.notFound(old_string)));
				}
				if (replacement.kind === "multipleMatches") {
					throw new Error(toolUseError(CC_TOOL_ERRORS.multipleMatches(replacement.count, old_string)));
				}
				if (replacement.next === content) {
					throw new Error(toolUseError(CC_TOOL_ERRORS.noChanges));
				}

				const finalContent = bom + restoreLineEndings(replacement.next, originalEnding);
				await writeFile(absolutePath, finalContent);
				throwIfAborted();
				await options.readState.record(absolutePath, finalContent);

				const diff = generateDiffString(content, replacement.next);
				const wording = replaceAll
					? `The file ${file_path} has been updated. All occurrences were successfully replaced.`
					: `The file ${file_path} has been updated successfully.`;
				return {
					content: [{ type: "text", text: `${wording} ${CC_FILE_STATE_SUFFIX}` }],
					details: {
						diff: diff.diff,
						patch: generateUnifiedPatch(file_path, content, replacement.next),
						firstChangedLine: diff.firstChangedLine,
					},
				};
			});
		},
		...editRenderers,
	};
}

type Replacement =
	| { kind: "applied"; next: string }
	| { kind: "notFound" }
	| { kind: "multipleMatches"; count: number };

/**
 * pi's matcher decides where a match is, and pi's replacement write-back produces the new content.
 * Exact occurrences are counted first because Claude Code reports the count for a duplicate
 * old_string; a string pi can only match fuzzily is a single occurrence.
 */
function replaceText(content: string, oldText: string, newText: string, replaceAll: boolean): Replacement {
	const indexes = indexesOf(content, oldText);
	if (indexes.length === 0) {
		const match = fuzzyFindText(content, oldText);
		if (!match.found) return { kind: "notFound" };
		return {
			kind: "applied",
			next: applyReplacementsPreservingUnchangedLines(content, match.contentForReplacement, [
				{ matchIndex: match.index, matchLength: match.matchLength, newText },
			]),
		};
	}
	if (indexes.length > 1 && !replaceAll) {
		return { kind: "multipleMatches", count: indexes.length };
	}

	const edits = replaceAll ? indexes : indexes.slice(0, 1);
	return {
		kind: "applied",
		next: applyReplacementsPreservingUnchangedLines(
			content,
			content,
			edits.map((matchIndex) => ({ matchIndex, matchLength: oldText.length, newText })),
		),
	};
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

async function statOrUndefined(absolutePath: string): Promise<Stats | undefined> {
	try {
		return await fsStat(absolutePath);
	} catch {
		return undefined;
	}
}
