/**
 * The `--settings` value: inline JSON when it starts with `{`, otherwise a file path resolved against
 * the working directory. Never throws; a value that cannot be read or parsed comes back as the same
 * three outcomes a settings file produces, so the caller reports both the same way.
 */

import { readFileSync } from "node:fs";
import { resolvePath } from "../../../utils/paths.ts";
import { type CcDocumentParse, type CcDocumentProblem, parseCcSettingsText } from "./keys.ts";

/** The name a failure from inline JSON is reported under, since there is no file to name. */
export const FLAG_SETTINGS_LABEL = "--settings";

export type CcFlagSettings =
	| { readonly kind: "document"; readonly path: string; readonly values: Record<string, unknown> }
	| { readonly kind: "malformed"; readonly path: string }
	| { readonly kind: "shape"; readonly path: string; readonly problems: readonly CcDocumentProblem[] };

export function parseFlagSettings(value: string, cwd: string): CcFlagSettings {
	const trimmed = value.trim();
	if (trimmed.startsWith("{")) {
		return withPath(FLAG_SETTINGS_LABEL, parseCcSettingsText(trimmed));
	}
	const path = resolvePath(trimmed, cwd);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { kind: "shape", path, problems: [{ key: undefined, detail: `could not read the file: ${detail}` }] };
	}
	return withPath(path, parseCcSettingsText(text));
}

function withPath(path: string, parsed: CcDocumentParse): CcFlagSettings {
	switch (parsed.kind) {
		case "document":
			return { kind: "document", path, values: parsed.values };
		case "malformed":
			return { kind: "malformed", path };
		case "shape":
			return { kind: "shape", path, problems: parsed.problems };
	}
}
