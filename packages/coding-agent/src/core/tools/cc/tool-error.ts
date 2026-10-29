/**
 * Every refusal and failure string the Claude Code tool definitions emit, in one table a reviewer
 * can diff against the recorded measurements.
 */

/** `<tool_use_error>` envelope for a tool failure (measured). */
export function toolUseError(message: string): string {
	return `<tool_use_error>${message}</tool_use_error>`;
}

/** The result for a call that names no registered tool (measured). */
export function unknownToolResult(name: string): string {
	return toolUseError(`Error: No such tool available: ${name}`);
}

export const CC_TOOL_ERRORS = {
	notRead: "File has not been read yet. Read it first before writing to it.",
	staleRead:
		"File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
	notFound: (oldString: string) => `String to replace not found in file.\nString: ${oldString}`,
	multipleMatches: (count: number, oldString: string) =>
		`Found ${count} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldString}`,
	noChanges: "No changes to make: old_string and new_string are exactly the same.",
	fileExists: "Cannot create new file - file already exists.",
	reportFilename:
		"Subagents should return findings as text, not write report files. Include this content in your final response instead.",
	placeholderCalled: "DeferredToolPlaceholder is reserved for deferred tool loading and cannot be called.",
} as const;
