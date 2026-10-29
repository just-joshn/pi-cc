/**
 * The `--settings` value: inline JSON when it starts with `{`, otherwise a file path resolved against
 * the working directory. Never throws; a value that cannot be read or parsed is a failure the caller
 * reports and skips.
 */

import { readFileSync } from "node:fs";
import { resolvePath } from "../../../utils/paths.ts";
import { parseCcSettingsText } from "./keys.ts";

/** The name a failure from inline JSON is reported under, since there is no file to name. */
export const FLAG_SETTINGS_LABEL = "--settings";

export type CcFlagSettings =
	| { readonly kind: "document"; readonly path: string; readonly values: Record<string, unknown> }
	| { readonly kind: "failure"; readonly path: string; readonly malformed: boolean; readonly detail: string };

export function parseFlagSettings(value: string, cwd: string): CcFlagSettings {
	const trimmed = value.trim();
	if (trimmed.startsWith("{")) {
		return documentOrFailure(FLAG_SETTINGS_LABEL, trimmed);
	}
	const path = resolvePath(trimmed, cwd);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { kind: "failure", path, malformed: true, detail: `could not read the file: ${detail}` };
	}
	return documentOrFailure(path, text);
}

function documentOrFailure(path: string, text: string): CcFlagSettings {
	const parsed = parseCcSettingsText(text);
	if (parsed.kind === "document") {
		return { kind: "document", path, values: parsed.values };
	}
	return { kind: "failure", path, malformed: parsed.kind === "malformed", detail: parsed.detail };
}
