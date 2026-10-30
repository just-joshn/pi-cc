/**
 * Claude Code's tool result and refusal text, in one table a reviewer can diff against the
 * measurements in the P03 record.
 *
 * These are strings, not behavior: `read`, `edit` and `write` emit them because Claude Code's
 * model is the only reader, and the P03 record cites each one.
 */

/** `<tool_use_error>` envelope for a tool failure. */
export function toolUseError(message: string): string {
	return `<tool_use_error>${message}</tool_use_error>`;
}

/** The suffix a successful Edit or Write appends while the file's content is in the model's context. */
export const CC_FILE_STATE_SUFFIX = "(file state is current in your context — no need to Read it back)";

/** Claude Code's default cap on the size of a file one Read may return. */
export const CC_READ_MAX_BYTES = 256 * 1024;

/** Claude Code's cap on how much text one Read returns, in tokens. */
export const CC_READ_MAX_TOKENS = 25_000;

/** pi's token estimate, used for the read cap so one number governs the whole application. */
export function estimateTextTokens(text: string): number {
	return Math.ceil(Buffer.byteLength(text, "utf-8") / 4);
}

/** Sizes as Claude Code prints them: whole kilobytes, one decimal for megabytes. */
export function formatCcSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export const CC_TOOL_TEXT = {
	readEmptyFile: "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>",
	readShortOffset: (offset: number, totalLines: number) =>
		`<system-reminder>Warning: the file exists but is shorter than the provided offset (${offset}). The file has ${totalLines} lines.</system-reminder>`,
	readMissing: (cwd: string) => `File does not exist. Note: your current working directory is ${cwd}.`,
	readDirectory: (absolutePath: string) => `EISDIR: illegal operation on a directory, read '${absolutePath}'`,
	readBinary: (extension: string) =>
		`This tool cannot read binary files. The file appears to be a binary ${extension} file. Use a skill for this file type if one is available, or a shell command or script that can read the format.`,
	readTooLarge: (size: string, maxSize: string, advice: string) =>
		`File content (${size}) exceeds maximum allowed size (${maxSize}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.${advice}`,
	readTooManyTokens: (tokens: number, maxTokens: number, advice: string) =>
		`File content (${tokens} tokens) exceeds maximum allowed tokens (${maxTokens}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.${advice}`,
	/** The closing advice when the refused content would fit the context left this turn. */
	readRetryAdvice:
		" To read it anyway, up to what still fits in your context, call Read again with allow_large: true — only if you genuinely need all of it or the user asked for the whole file.",
	/** The closing advice when even allow_large could not fit the content. */
	readNoRoomAdvice:
		" Even with allow_large, this is more than fits in the context you have left this turn (other large reads in the same turn share that room).",
	readPartialNotice: (absolutePath: string, shown: number, total: number, size: string, advice: string) =>
		`[Truncated: PARTIAL view — ${absolutePath}: showing lines 1-${shown} of ${total} total (${size}). Call Read with offset=${shown + 1} limit=${shown} for the next page, or Grep to find a specific section.${advice} Do NOT answer from this page alone if the answer may be further in the file.]`,
	/** The partial notice's size note for a plain read, and for an allow_large read the room could not hold. */
	readPartialSize: (tokens: number) => `${tokens} tokens, cap ${CC_READ_MAX_TOKENS}`,
	readPartialSizeOverRoom: (tokens: number, room: number) =>
		`${tokens} tokens, allow_large had room for ${room} tokens this turn`,
	editNotRead: "File has not been read yet. Read it first before writing to it.",
	editStale:
		"File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
	/** Replaces the file-state suffix when Claude Code recovers a stale read by applying the edit. */
	editStaleRecoveryNote:
		" (note: the file had been modified on disk since you last read it — the edit applied cleanly, but the file contains other changes not in your context. Read it before edits that depend on surrounding content.)",
	editNotFound: (oldText: string) => `String to replace not found in file.\nString: ${oldText}`,
	editMultipleMatches: (count: number, oldText: string) =>
		`Found ${count} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldText}`,
	editNoChanges: "No changes to make: old_string and new_string are exactly the same.",
	editFileExists: "Cannot create new file - file already exists.",
	writeReportRefusal:
		"Subagents should return findings as text, not write report files. Include this content in your final response instead.",
} as const;
