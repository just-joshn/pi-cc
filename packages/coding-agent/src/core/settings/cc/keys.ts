/**
 * The document shape: which JSON kind each documented Claude Code key must have, how two tiers merge
 * one key, and the parser that applies the table to a settings file. A file that fails the table is
 * reported once and skipped whole, because a half-applied settings document is worse than none.
 */

import { stripBom } from "../../../utils/text.ts";

export type CcJsonKind = "string" | "boolean" | "number" | "array" | "object";

/** Documented Claude Code settings keys and the JSON kind each one must have. */
export const KEY_KINDS: Readonly<Record<string, CcJsonKind>> = {
	// Scalars a session reads, or that a later unit maps onto pi.
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
	// Booleans.
	allowManagedHooksOnly: "boolean",
	allowManagedMcpServersOnly: "boolean",
	allowManagedPermissionRulesOnly: "boolean",
	autoCompactEnabled: "boolean",
	autoUpdates: "boolean",
	disableAllHooks: "boolean",
	enforceAvailableModels: "boolean",
	forceRemoteSettingsRefresh: "boolean",
	includeCoAuthoredBy: "boolean",
	respectGitignore: "boolean",
	// Numbers.
	cleanupPeriodDays: "number",
	desktopSessionCleanupPeriodDays: "number",
	// Arrays. Every array key merges by concatenation except `fallbackModel`, which is a string.
	additionalMarketplaces: "array",
	allowedChannelPlugins: "array",
	allowedHttpHookUrls: "array",
	allowedMarketplaces: "array",
	allowedMcpServers: "array",
	availableModels: "array",
	blockedMarketplaces: "array",
	deniedMcpServers: "array",
	deniedModels: "array",
	disabledMcpjsonServers: "array",
	enabledMcpjsonServers: "array",
	enabledPlugins: "array",
	httpHookAllowedEnvVars: "array",
	pluginSuggestionMarketplaces: "array",
	strictKnownMarketplaces: "array",
	// Objects. These are loaded and exposed; P04, P07, P08 and P24 act on them.
	agents: "object",
	claudeMd: "object",
	env: "object",
	extraKnownMarketplaces: "object",
	hooks: "object",
	mcpServers: "object",
	managedMcpServers: "object",
	modelOverrides: "object",
	modelPicker: "object",
	modelPricing: "object",
	permissions: "object",
	pluginConfigs: "object",
	plugins: "object",
	sandbox: "object",
	skills: "object",
	statusLine: "object",
	// `allowedProviders` is deliberately absent: policy.ts validates it, so a bad value must reach
	// the policy gate and refuse the run instead of being dropped here as a shape failure.
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

export type CcDocumentParse =
	| { readonly kind: "document"; readonly values: Record<string, unknown> }
	| { readonly kind: "malformed"; readonly detail: string }
	| { readonly kind: "shape"; readonly detail: string };

/** Parses one settings document and checks every documented key against its kind. */
export function parseCcSettingsText(text: string): CcDocumentParse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(text));
	} catch (error) {
		return { kind: "malformed", detail: error instanceof Error ? error.message : String(error) };
	}
	if (!isJsonObject(parsed)) {
		return { kind: "shape", detail: `expected a JSON object, found ${describeValue(parsed)}` };
	}
	const problems: string[] = [];
	for (const [key, value] of Object.entries(parsed)) {
		const problem = keyKindProblem(key, value);
		if (problem !== undefined) {
			problems.push(problem);
		}
	}
	if (problems.length > 0) {
		return { kind: "shape", detail: problems.join("; ") };
	}
	return { kind: "document", values: parsed };
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyKindProblem(key: string, value: unknown): string | undefined {
	const kind = KEY_KINDS[key];
	if (kind === undefined) {
		return undefined;
	}
	if (!matchesKind(value, kind)) {
		return `${key} must be ${kindName(kind)}, found ${describeValue(value)}`;
	}
	// An env block is a flat string map in Claude Code, so a non-string entry invalidates the file.
	if (key === "env" && isJsonObject(value) && !Object.values(value).every((entry) => typeof entry === "string")) {
		return "env values must be strings";
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

function kindName(kind: CcJsonKind): string {
	return kind === "array" ? "an array" : kind === "object" ? "an object" : kind;
}

function describeValue(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (Array.isArray(value)) {
		return "an array";
	}
	return typeof value === "object" ? "an object" : `${typeof value} ${JSON.stringify(value)}`;
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
