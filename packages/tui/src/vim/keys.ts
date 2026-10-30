import { BACKSPACE } from "./motions.ts";

export type PendingClass = "idle" | "count" | "operator" | "other";

/** What Claude Code's key router does with one non-printable key (chunk-hz2c9q6k.js:1496-1662). */
export type KeyRoute =
	| { readonly route: "key"; readonly key: string }
	/** Normal mode: the editor acts on the key and the pending command stays. */
	| { readonly route: "editor" }
	/** Visual mode: a Ctrl or Alt chord ends visual mode and is consumed. */
	| { readonly route: "leave" }
	/** Neither vim nor the editor acts, and the pending command stays. */
	| { readonly route: "drop" };

const ARROWS: Readonly<Record<string, string>> = { left: "h", right: "l", up: "k", down: "j" };
const CHORD = /(^|\+)(ctrl|alt|meta|super)\+/;

export function pendingClass(pending: string): PendingClass {
	if (pending === "") return "idle";
	if (/^[1-9]\d*$/.test(pending)) return "count";
	if (/^[dcy]\d*$/.test(pending)) return "operator";
	return "other";
}

/**
 * Normal mode maps arrows into any pending command, Backspace only from idle, count or operator, and Delete only from
 * idle or operator. Visual mode maps them only from idle or count and cancels any other pending command with an empty
 * key; Enter there is a newline key then. Everything else that is not a character is dropped.
 */
export function routeSpecialKey(
	parsed: string | undefined,
	mode: "normal" | "visual",
	pending: PendingClass,
): KeyRoute {
	if (parsed !== undefined && CHORD.test(parsed)) return mode === "visual" ? { route: "leave" } : { route: "editor" };
	const shifted = parsed?.startsWith("shift+") === true;
	const name = shifted ? parsed?.slice("shift+".length) : parsed;
	const motion = pending === "idle" || pending === "count";
	const arrow = name === undefined ? undefined : ARROWS[name];
	if (mode === "visual") {
		const key = (when: boolean, mapped: string): KeyRoute => ({ route: "key", key: when ? mapped : "" });
		if (arrow !== undefined) return key(motion, arrow);
		if (name === "enter") return key(true, motion ? "j" : "\n");
		if (name === "backspace") return key(motion, BACKSPACE);
		if (name === "delete") return key(pending === "idle", "x");
		return { route: "drop" };
	}
	if (name === "enter") return { route: "editor" };
	if (arrow !== undefined) {
		if (pending === "idle" && !shifted && (name === "up" || name === "down")) return { route: "editor" };
		return { route: "key", key: arrow };
	}
	if (name === "backspace") return pending === "other" ? { route: "drop" } : { route: "key", key: BACKSPACE };
	if (name === "delete") {
		return pending === "idle" || pending === "operator" ? { route: "key", key: "x" } : { route: "drop" };
	}
	return { route: "drop" };
}
