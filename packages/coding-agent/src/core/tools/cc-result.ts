/** Claude Code's structured result of one tool call: the `tool_use_result` of a stream-json row and the `tool_response` a hook sees. */

const NUMBERED_LINE = /^\d+\t/;

/**
 * Read and Bash have the measured structure. Every other tool reports its result text, and an error
 * reports `Error: <text>`.
 */
export function ccToolUseResult(
	modelName: string | undefined,
	modelInput: Readonly<Record<string, unknown>>,
	text: string,
	isError: boolean,
): unknown {
	if (isError) return `Error: ${text}`;
	if (modelName === "Bash") {
		return { stdout: text, stderr: "", interrupted: false, isImage: false, noOutputExpected: false };
	}
	const lines = text.split("\n");
	if (modelName === "Read" && lines.every((line) => NUMBERED_LINE.test(line))) {
		const offset = typeof modelInput.offset === "number" ? modelInput.offset : 1;
		return {
			type: "text",
			file: {
				filePath: String(modelInput.file_path ?? ""),
				content: lines.map((line) => line.replace(NUMBERED_LINE, "")).join("\n"),
				numLines: lines.length,
				startLine: offset,
				totalLines: lines.length,
			},
		};
	}
	return text;
}
