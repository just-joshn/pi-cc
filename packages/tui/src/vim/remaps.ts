// Insert-mode remaps (the vimInsertModeRemaps setting): which keys leave insert mode, parsed and matched
// the way Claude Code does it.
import { visibleWidth } from "../utils.ts";
import type { Buffer } from "./edits.ts";

export type VimInsertRemaps = ReadonlyMap<string, "<Esc>">;

/** Vim mode settings the host passes to the editor. */
export interface VimConfig {
	readonly insertRemaps: VimInsertRemaps;
	/** Clock for the remap window, in milliseconds. Defaults to Date.now. */
	readonly now?: () => number;
}

/** How long the second key of a remap may trail the first. */
export const REMAP_WINDOW_MS = 1000;

/**
 * Reads the setting's raw value. An entry counts when its value is "<esc>" in any case and its key is exactly
 * two characters, none of them control or separator characters, two terminal columns wide. Anything else is dropped.
 */
export function parseVimInsertRemaps(raw: unknown): VimInsertRemaps {
	const remaps = new Map<string, "<Esc>">();
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return remaps;
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value !== "string" || value.toLowerCase() !== "<esc>") continue;
		const normalized = key.normalize("NFC");
		if (!/^[^\p{C}\p{Z}]{2}$/u.test(normalized) || visibleWidth(normalized) !== 2) continue;
		remaps.set(normalized, "<Esc>");
	}
	return remaps;
}

/** The first character of a remap that was just typed, waiting for its second. */
export interface PendingRemap {
	readonly char: string;
	readonly at: number;
	readonly offsetAfter: number;
}

export interface RemapStep {
	/** "pair": the second key arrived; "chunk": both keys arrived in one read. */
	readonly fire?: "pair" | "chunk";
	readonly pending?: PendingRemap;
}

/** Evaluates one typed key in insert mode, given the previous pending first character. */
export function stepRemap(
	remaps: VimInsertRemaps,
	pending: PendingRemap | undefined,
	typed: string,
	buffer: Buffer,
	now: number,
): RemapStep {
	if (remaps.size === 0) return {};
	const key = typed.normalize("NFC");
	const chars = [...key];
	if (chars.length === 1) {
		const continues =
			pending !== undefined &&
			remaps.has(pending.char + key) &&
			now - pending.at <= REMAP_WINDOW_MS &&
			buffer.offset === pending.offsetAfter &&
			buffer.text.startsWith(pending.char, buffer.offset - pending.char.length);
		if (continues) return { fire: "pair" };
		for (const remap of remaps.keys()) {
			if ([...remap][0] === key) return { pending: { char: key, at: now, offsetAfter: buffer.offset + key.length } };
		}
		return {};
	}
	if (chars.length === 2 && remaps.has(key)) return { fire: "chunk" };
	return {};
}
