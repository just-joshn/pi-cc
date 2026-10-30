/** Which flags select the Claude Code SDK host, and the couplings between them that Claude Code enforces. */

export type SdkOutputFormat = "json" | "stream-json";

export interface SdkFlagInput {
	/** An explicit `--mode` keeps pi's own json and rpc protocols, so these flags do not select the SDK host. */
	mode?: string | undefined;
	outputFormat?: string | undefined;
	inputFormat?: string | undefined;
	includePartialMessages?: boolean | undefined;
	replayUserMessages?: boolean | undefined;
}

/** The SDK output format a command line asks for, or undefined when pi's own modes apply. */
export function sdkOutputFormat(flags: Pick<SdkFlagInput, "mode" | "outputFormat">): SdkOutputFormat | undefined {
	if (flags.mode !== undefined) return undefined;
	return flags.outputFormat === "json" || flags.outputFormat === "stream-json" ? flags.outputFormat : undefined;
}

/** The first coupling error, in the order Claude Code checks them, or undefined. Messages are Claude Code's, measured. */
export function sdkFlagProblem(flags: SdkFlagInput): string | undefined {
	if (flags.mode !== undefined) return undefined;
	const streamIn = flags.inputFormat === "stream-json";
	const streamOut = flags.outputFormat === "stream-json";
	if (streamIn && !streamOut) return "Error: --input-format=stream-json requires output-format=stream-json.";
	if (flags.replayUserMessages && !(streamIn && streamOut)) {
		return "Error: --replay-user-messages requires both --input-format=stream-json and --output-format=stream-json.";
	}
	if (flags.includePartialMessages && !streamOut) {
		return "Error: --include-partial-messages requires --print and --output-format=stream-json.";
	}
	return undefined;
}

export const STREAM_JSON_REQUIRES_VERBOSE = "Error: When using --print, --output-format=stream-json requires --verbose";
