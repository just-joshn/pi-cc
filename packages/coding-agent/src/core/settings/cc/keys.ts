/**
 * The document shape: which JSON kind each Claude Code key must have, how two tiers merge one key, and
 * the parser that applies the table to a settings file. Claude Code names a file that fails the table
 * on stderr and loads none of it, so a document with one bad key contributes nothing.
 */

import { stripBom } from "../../../utils/text.ts";

export type CcJsonKind = "string" | "boolean" | "number" | "array" | "object";

/**
 * Documented Claude Code keys whose JSON kind is known here. A key outside this table still loads and
 * stays readable through `CcSettings.values`; it is unchecked because guessing a kind would turn a
 * valid file into a "did not load" block. The table grows as later units learn each key's shape.
 */
export const KEY_KINDS: Readonly<Record<string, CcJsonKind>> = {
	model: "string",
	fallbackModel: "string",
	advisorModel: "string",
	apiKeyHelper: "string",
	outputStyle: "string",
	theme: "string",
	forceLoginMethod: "string",
	forceLoginOrgUUID: "string",
	requiredMinimumVersion: "string",
	requiredMaximumVersion: "string",
	autoUpdatesChannel: "string",

	allowManagedHooksOnly: "boolean",
	allowManagedMcpServersOnly: "boolean",
	allowManagedPermissionRulesOnly: "boolean",
	autoCompactEnabled: "boolean",
	autoUpdates: "boolean",
	disableAllHooks: "boolean",
	enforceAvailableModels: "boolean",
	respectGitignore: "boolean",

	cleanupPeriodDays: "number",
	desktopSessionCleanupPeriodDays: "number",

	allowedHttpHookUrls: "array",
	allowedMarketplaces: "array",
	allowedMcpServers: "array",
	availableModels: "array",
	blockedMarketplaces: "array",
	deniedMcpServers: "array",
	deniedModels: "array",
	disabledMcpjsonServers: "array",
	enabledMcpjsonServers: "array",
	httpHookAllowedEnvVars: "array",
	strictKnownMarketplaces: "array",

	env: "object",
	hooks: "object",
	mcpServers: "object",
	permissions: "object",
	sandbox: "object",
	statusLine: "object",
	// `allowedProviders` is deliberately absent: policy.ts validates it, so a bad value must reach the
	// policy gate and refuse the run instead of being dropped here as a shape failure.
};

/** Policy keys that replace the merged value when the policy tier defines them. */
export const POLICY_FORCED: readonly string[] = ["availableModels", "enforceAvailableModels", "modelPicker"];

/** A policy key copied from the policy tier when it defines one, and deleted when it does not. */
export const POLICY_DROPPED: readonly string[] = ["deniedModels"];

/** Keys that merge per entry instead of being replaced whole, so a later tier adds to an earlier one. */
const SHALLOW_MERGE_KEYS: ReadonlySet<string> = new Set([
	// Env unions across tiers and wins per variable, which is what the harness measured.
	"env",
	"extraKnownMarketplaces",
	"managedMcpServers",
]);

export function mergeValue(key: string, previous: unknown, next: unknown): unknown {
	if (SHALLOW_MERGE_KEYS.has(key) && isJsonObject(previous) && isJsonObject(next)) {
		return { ...previous, ...next };
	}
	if (key !== "fallbackModel" && KEY_KINDS[key] === "array" && Array.isArray(previous) && Array.isArray(next)) {
		return concatUnique(previous, next);
	}
	return next;
}

/** One reason a document does not load. `key` is absent when the whole document is the problem. */
export interface CcDocumentProblem {
	readonly key: string | undefined;
	readonly detail: string;
}

export type CcDocumentParse =
	| { readonly kind: "document"; readonly values: Record<string, unknown> }
	| { readonly kind: "malformed" }
	| { readonly kind: "shape"; readonly problems: readonly CcDocumentProblem[] };

export function parseCcSettingsText(text: string): CcDocumentParse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(text));
	} catch {
		return { kind: "malformed" };
	}
	if (!isJsonObject(parsed)) {
		return {
			kind: "shape",
			problems: [{ key: undefined, detail: `Expected object, but received ${describe(parsed)}` }],
		};
	}
	const problems: CcDocumentProblem[] = [];
	for (const [key, value] of Object.entries(parsed)) {
		const problem = keyProblem(key, value);
		if (problem !== undefined) {
			problems.push({ key, detail: problem });
		}
	}
	return problems.length > 0 ? { kind: "shape", problems } : { kind: "document", values: parsed };
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyProblem(key: string, value: unknown): string | undefined {
	const kind = KEY_KINDS[key];
	if (kind === undefined) {
		return undefined;
	}
	if (!matchesKind(value, kind)) {
		return `Expected ${kind}, but received ${describe(value)}`;
	}
	// An env block is a flat string map in Claude Code, so a non-string entry is a problem of its own.
	if (key === "env" && isJsonObject(value)) {
		const entry = Object.entries(value).find(([, envValue]) => typeof envValue !== "string");
		if (entry !== undefined) {
			return `Expected string for env.${entry[0]}, but received ${describe(entry[1])}`;
		}
	}
	return undefined;
}

function matchesKind(value: unknown, kind: CcJsonKind): boolean {
	switch (kind) {
		case "string":
			return typeof value === "string";
		case "boolean":
			return typeof value === "boolean";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "array":
			return Array.isArray(value);
		case "object":
			return isJsonObject(value);
	}
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

function concatUnique(previous: readonly unknown[], next: readonly unknown[]): unknown[] {
	const seen = new Set<string>();
	const merged: unknown[] = [];
	for (const entry of [...previous, ...next]) {
		const identity = JSON.stringify(entry) ?? "undefined";
		if (seen.has(identity)) {
			continue;
		}
		seen.add(identity);
		merged.push(entry);
	}
	return merged;
}
