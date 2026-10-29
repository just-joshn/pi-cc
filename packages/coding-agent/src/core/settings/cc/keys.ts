/**
 * The document shape: which JSON kind each Claude Code key must have, how two tiers merge one key, and
 * the parser that applies the table to a settings file. Claude Code names a file that fails the table
 * on stderr and loads none of it, so a document with one bad key contributes nothing.
 */

import { stripBom } from "../../../utils/text.ts";
import type { CcSettingsSource } from "./types.ts";

export type CcJsonKind = "string" | "boolean" | "number" | "object" | "array" | "record";

export interface CcFieldRule {
	readonly kind: CcJsonKind | "enum";
	/** The admitted spellings of an enum field. */
	readonly values?: readonly string[];
	/** The sub-fields of an object field. A sub-key outside this table loads unchecked. */
	readonly fields?: Readonly<Record<string, CcFieldRule>>;
	/** Array entries: `remove` drops a non-string entry and reports it, `reject` fails the file. */
	readonly entries?: "remove" | "reject";
}

/** One field a file kept while the rest of it loaded. */
export interface CcFieldSkip {
	readonly key: string;
	readonly detail: string;
}

/**
 * The measured 2.1.312 table. A key outside it still loads and stays readable through
 * `CcSettings.values`, because Claude Code accepts a wrong type for the keys it does not validate and
 * guessing a kind would turn a valid file into a "did not load" block.
 */
export const SETTINGS_FIELDS: Readonly<Record<string, CcFieldRule>> = {
	model: { kind: "string" },
	advisorModel: { kind: "string" },
	apiKeyHelper: { kind: "string" },
	outputStyle: { kind: "string" },
	requiredMinimumVersion: { kind: "string" },
	requiredMaximumVersion: { kind: "string" },
	autoUpdatesChannel: { kind: "enum", values: ["latest", "stable", "rc"] },

	allowManagedHooksOnly: { kind: "boolean" },
	allowManagedMcpServersOnly: { kind: "boolean" },
	allowManagedPermissionRulesOnly: { kind: "boolean" },
	autoCompactEnabled: { kind: "boolean" },
	disableAllHooks: { kind: "boolean" },
	enforceAvailableModels: { kind: "boolean" },
	respectGitignore: { kind: "boolean" },

	cleanupPeriodDays: { kind: "number" },
	desktopSessionCleanupPeriodDays: { kind: "number" },

	allowedHttpHookUrls: { kind: "array" },
	availableModels: { kind: "array" },
	blockedMarketplaces: { kind: "array" },
	httpHookAllowedEnvVars: { kind: "array" },
	strictKnownMarketplaces: { kind: "array" },
	fallbackModel: { kind: "array" },

	env: { kind: "record" },
	permissions: {
		kind: "object",
		fields: {
			allow: { kind: "array", entries: "remove" },
			ask: { kind: "array", entries: "remove" },
			deny: { kind: "array", entries: "remove" },
			additionalDirectories: { kind: "array", entries: "reject" },
			defaultMode: {
				kind: "enum",
				values: ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"],
			},
			disableBypassPermissionsMode: { kind: "enum", values: ["disable"] },
		},
	},
	sandbox: { kind: "object" },
	statusLine: { kind: "object" },
	// `allowedProviders` is deliberately absent: policy.ts validates it, so a bad value must reach the
	// policy gate and refuse the run instead of being dropped here as a shape failure.
};

interface CcLenientRule {
	readonly admits: (value: unknown) => boolean;
	readonly detail: (value: unknown) => string;
}

/**
 * Fields Claude Code reports as skipped instead of refusing the file: a wrong type here drops the
 * field and lets the rest of the document load.
 */
const LENIENT_FIELDS: Readonly<Record<string, CcLenientRule>> = {
	hooks: {
		admits: isJsonObject,
		detail: (value) =>
			`"hooks" must be an object mapping event names to matcher arrays; received ${describe(value)}. This field was ignored.`,
	},
	allowedMcpServers: {
		admits: Array.isArray,
		detail: (value) => `"allowedMcpServers" must be an array; received ${describe(value)}. This field was ignored.`,
	},
	deniedMcpServers: {
		admits: Array.isArray,
		detail: (value) => `"deniedMcpServers" must be an array; received ${describe(value)}. This field was ignored.`,
	},
};

/** Old spellings Claude Code renames before validation. The alias itself never reaches the values. */
const FIELD_ALIASES: Readonly<Record<string, string>> = {
	additionalMarketplaces: "extraKnownMarketplaces",
	allowedMarketplaces: "strictKnownMarketplaces",
};

/** Policy keys that replace the merged value when the policy tier defines them. */
export const POLICY_FORCED: readonly string[] = ["availableModels", "enforceAvailableModels", "modelPicker"];

/** A policy key copied from the policy tier when it defines one, and deleted when it does not. */
export const POLICY_DROPPED: readonly string[] = ["deniedModels"];

/** Keys whose entries replace each other instead of merging recursively. */
const SHALLOW_MERGE_KEYS: ReadonlySet<string> = new Set(["extraKnownMarketplaces", "managedMcpServers"]);

/** Keys replaced whole even when both sides are objects. */
const REPLACE_KEYS: ReadonlySet<string> = new Set(["modelPicker"]);

export function mergeValue(key: string, previous: unknown, next: unknown): unknown {
	if (Array.isArray(previous) && Array.isArray(next)) {
		// `fallbackModel` is a preference list, so a later tier replaces it instead of appending.
		return key === "fallbackModel" ? next : [...new Set([...previous, ...next])];
	}
	if (isJsonObject(previous) && isJsonObject(next)) {
		if (REPLACE_KEYS.has(key)) {
			return next;
		}
		if (SHALLOW_MERGE_KEYS.has(key)) {
			return { ...previous, ...next };
		}
		const merged: Record<string, unknown> = { ...previous };
		for (const [childKey, childNext] of Object.entries(next)) {
			merged[childKey] = childKey in previous ? mergeValue(childKey, previous[childKey], childNext) : childNext;
		}
		return merged;
	}
	return next;
}

/** One reason a document does not load. `key` is absent when the whole document is the problem. */
export interface CcDocumentProblem {
	readonly key: string | undefined;
	readonly detail: string;
}

export type CcDocumentParse =
	| {
			readonly kind: "document";
			readonly values: Record<string, unknown>;
			readonly skipped: readonly CcFieldSkip[];
	  }
	| { readonly kind: "malformed" }
	| { readonly kind: "shape"; readonly problems: readonly CcDocumentProblem[] };

export function parseCcSettingsText(text: string, source: CcSettingsSource): CcDocumentParse {
	const stripped = stripBom(text);
	if (stripped.trim().length === 0) {
		return { kind: "document", values: {}, skipped: [] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripped);
	} catch {
		return { kind: "malformed" };
	}
	if (parsed === null) {
		return { kind: "malformed" };
	}
	if (!isJsonObject(parsed)) {
		return {
			kind: "shape",
			problems: [{ key: undefined, detail: `Expected object, but received ${describe(parsed)}` }],
		};
	}
	const values: Record<string, unknown> = {};
	const problems: CcDocumentProblem[] = [];
	const skipped: CcFieldSkip[] = [];
	for (const [key, value] of Object.entries(applyAliases(parsed))) {
		readField(key, value, source, values, problems, skipped);
	}
	return problems.length > 0 ? { kind: "shape", problems } : { kind: "document", values, skipped };
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface CcFieldOutcome {
	readonly value: unknown;
	readonly problems: readonly CcDocumentProblem[];
	readonly skipped: readonly CcFieldSkip[];
}

function readField(
	key: string,
	value: unknown,
	source: CcSettingsSource,
	values: Record<string, unknown>,
	problems: CcDocumentProblem[],
	skipped: CcFieldSkip[],
): void {
	const rule = SETTINGS_FIELDS[key];
	if (rule !== undefined) {
		const outcome = validateField(key, value, rule);
		problems.push(...outcome.problems);
		skipped.push(...outcome.skipped);
		if (outcome.problems.length === 0) {
			values[key] = outcome.value;
		}
		return;
	}
	const lenient = LENIENT_FIELDS[key];
	if (lenient !== undefined) {
		if (lenient.admits(value)) {
			values[key] = value;
		} else {
			skipped.push({ key, detail: lenient.detail(value) });
		}
		return;
	}
	if (key === "deniedModels") {
		if (source === "policy") {
			values[key] = value;
		} else {
			skipped.push({ key, detail: '"deniedModels" is only honored from managed settings and was ignored here.' });
		}
		return;
	}
	values[key] = value;
}

function validateField(path: string, value: unknown, rule: CcFieldRule): CcFieldOutcome {
	if (rule.kind === "enum") {
		const admitted = rule.values ?? [];
		if (typeof value === "string" && admitted.includes(value)) {
			return ok(value);
		}
		const spellings = admitted.map((entry) => `"${entry}"`).join(", ");
		return failed(path, `Invalid value. Expected one of: ${spellings}`);
	}
	if (rule.kind === "record" && isJsonObject(value)) {
		return ok(coerceRecord(value));
	}
	if (rule.kind === "object" && isJsonObject(value)) {
		return validateObject(path, value, rule.fields ?? {});
	}
	if (rule.kind === "array" && Array.isArray(value)) {
		return validateArray(path, value, rule.entries);
	}
	if ((rule.kind === "string" || rule.kind === "boolean" || rule.kind === "number") && typeof value === rule.kind) {
		return ok(value);
	}
	return failed(path, `Expected ${rule.kind}, but received ${describe(value)}`);
}

function validateObject(
	path: string,
	value: Record<string, unknown>,
	fields: Readonly<Record<string, CcFieldRule>>,
): CcFieldOutcome {
	const result: Record<string, unknown> = {};
	const problems: CcDocumentProblem[] = [];
	const skipped: CcFieldSkip[] = [];
	for (const [key, entry] of Object.entries(value)) {
		const rule = fields[key];
		if (rule === undefined) {
			result[key] = entry;
			continue;
		}
		const outcome = validateField(`${path}.${key}`, entry, rule);
		problems.push(...outcome.problems);
		skipped.push(...outcome.skipped);
		if (outcome.problems.length === 0) {
			result[key] = outcome.value;
		}
	}
	return { value: result, problems, skipped };
}

function validateArray(
	path: string,
	value: readonly unknown[],
	entries: "remove" | "reject" | undefined,
): CcFieldOutcome {
	if (entries === undefined) {
		return ok(value);
	}
	const kept: unknown[] = [];
	const problems: CcDocumentProblem[] = [];
	const skipped: CcFieldSkip[] = [];
	value.forEach((entry, index) => {
		if (typeof entry === "string") {
			kept.push(entry);
			return;
		}
		if (entries === "remove") {
			skipped.push({ key: path, detail: `Non-string value in ${lastSegment(path)} array was removed` });
			return;
		}
		problems.push({ key: `${path}.${index}`, detail: `Expected string, but received ${describe(entry)}` });
	});
	return { value: kept, problems, skipped };
}

function ok(value: unknown): CcFieldOutcome {
	return { value, problems: [], skipped: [] };
}

function failed(key: string, detail: string): CcFieldOutcome {
	return { value: undefined, problems: [{ key, detail }], skipped: [] };
}

function applyAliases(document: Record<string, unknown>): Record<string, unknown> {
	const renamed: Record<string, unknown> = { ...document };
	for (const [alias, canonical] of Object.entries(FIELD_ALIASES)) {
		if (!(alias in renamed)) {
			continue;
		}
		if (!(canonical in renamed)) {
			renamed[canonical] = renamed[alias];
		}
		delete renamed[alias];
	}
	return renamed;
}

/** Claude Code coerces every env value with `String(value)`; nothing under `env` rejects the file. */
function coerceRecord(value: Record<string, unknown>): Record<string, string> {
	const coerced: Record<string, string> = {};
	for (const [name, entry] of Object.entries(value)) {
		coerced[name] = String(entry);
	}
	return coerced;
}

function lastSegment(path: string): string {
	const parts = path.split(".");
	return parts[parts.length - 1] ?? path;
}

function describe(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (Array.isArray(value)) {
		return "array";
	}
	return typeof value;
}
