/**
 * The `--settings` value: inline JSON when it starts with `{` and ends with `}`, otherwise a file path
 * resolved against the working directory. A value that cannot be parsed or read at all stops the run
 * the way Claude Code stops it; a readable file with bad contents is reported like any other tier.
 */

import { readFileSync } from "node:fs";
import { resolvePath } from "../../../utils/paths.ts";
import { type CcDocumentParse, type CcDocumentProblem, type CcFieldSkip, parseCcSettingsText } from "./keys.ts";

/** The name a failure from inline JSON is reported under, since there is no file to name. */
export const FLAG_SETTINGS_LABEL = "--settings (inline JSON)";

export type CcFlagSettings =
	| { readonly kind: "absent" }
	| {
			readonly kind: "document";
			readonly path: string;
			readonly values: Record<string, unknown>;
			readonly skipped: readonly CcFieldSkip[];
	  }
	| { readonly kind: "malformed"; readonly path: string }
	| { readonly kind: "invalid-json" }
	| { readonly kind: "missing"; readonly path: string }
	| { readonly kind: "unreadable"; readonly path: string; readonly detail: string }
	| { readonly kind: "shape"; readonly path: string; readonly problems: readonly CcDocumentProblem[] };

export function resolveFlagSettings(value: string | undefined, cwd: string): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 || (trimmed.startsWith("{") && trimmed.endsWith("}")) ? value : resolvePath(value, cwd);
}

export function parseFlagSettings(value: string, cwd: string): CcFlagSettings {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return { kind: "absent" };
	}
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		return inlineSettings(trimmed);
	}
	const path = resolvePath(value, cwd);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { kind: "missing", path };
		}
		const detail = error instanceof Error ? error.message : String(error);
		return { kind: "unreadable", path, detail };
	}
	return withPath(path, parseCcSettingsText(text, "flag"));
}

/** Inline JSON that does not parse, or parses to null, is fatal: there is no file to report against. */
function inlineSettings(text: string): CcFlagSettings {
	const parsed = parseCcSettingsText(text, "flag");
	if (parsed.kind === "malformed") {
		return { kind: "invalid-json" };
	}
	return withPath(FLAG_SETTINGS_LABEL, parsed);
}

function withPath(path: string, parsed: CcDocumentParse): CcFlagSettings {
	switch (parsed.kind) {
		case "document":
			return { kind: "document", path, values: parsed.values, skipped: parsed.skipped };
		case "malformed":
			return { kind: "malformed", path };
		case "shape":
			return { kind: "shape", path, problems: parsed.problems };
	}
}
