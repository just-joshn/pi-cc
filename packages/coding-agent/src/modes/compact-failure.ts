// The text a failed /compact reports, in the wording Claude Code uses.

import { CC_COMPACT_DISABLED, CC_NOT_ENOUGH_MESSAGES } from "../core/compaction/cc-policy.ts";

/** Names what went wrong with a manual compaction; failures without a dedicated message get Claude Code's prefix. */
export function compactFailureText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (message === CC_NOT_ENOUGH_MESSAGES || message === CC_COMPACT_DISABLED) return message;
	if (message === "Compaction cancelled") return "Compaction canceled.";
	return `Error during compaction: ${message}`;
}
