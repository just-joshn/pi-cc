/**
 * `ANTHROPIC_MODEL` and the per-family model variables, the model half of Claude Code's provider env.
 *
 * `ANTHROPIC_MODEL` names the session model and may use one of Claude Code's family aliases, `opusplan`,
 * `best`, a retired Opus id, or any of those with a `[1m]` context marker. A family variable pins what
 * that alias resolves to, and with no variable set the alias means the model the pinned build ships as
 * that family's default. Any other name is a model id: Claude Code sends it as written, including a name
 * it has never heard of, rather than refusing the run. A `[1m]` marker never reaches the wire; the
 * request carries the bare id.
 *
 * `ANTHROPIC_SMALL_FAST_MODEL` is deliberately not a source here: the pinned 2.1.312 does not read it for
 * the session model, it only names the small model behind background tasks
 * (`provider-env/small-fast-is-not-the-session-model`).
 */

const SESSION_MODEL_ENV = "ANTHROPIC_MODEL";
const REMAP_DISABLE_ENV = "CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP";
const FAMILIES = ["opus", "sonnet", "haiku", "fable"] as const;

/** Retired Opus ids Claude Code remaps to the Opus default (`chunk-3xe0k172.js` `hK`). */
const RETIRED_OPUS_IDS = ["claude-opus-4-20250514", "claude-opus-4-1-20250805", "claude-opus-4-0", "claude-opus-4-1"];

/** The dated Sonnet 4.5 id Claude Code's startup migration rewrites a settings `sonnet[1m]` into. */
const SONNET_1M_LEGACY = "sonnet-4-5-20250929[1m]";

export type AnthropicModelFamily = (typeof FAMILIES)[number];

export interface AnthropicModelEnv {
	model?: string;
	family: Partial<Record<AnthropicModelFamily, string>>;
	/** `CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP` set to a non-empty value. */
	legacyRemapDisabled: boolean;
}

const FAMILY_ENV: Record<AnthropicModelFamily, string> = {
	opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
	sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
	haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
	fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
};

/** What the pinned 2.1.312 resolves a bare family alias to when no variable redefines it. */
const FAMILY_DEFAULT: Record<AnthropicModelFamily, string> = {
	opus: "claude-opus-5-5",
	sonnet: "claude-sonnet-5-5",
	haiku: "claude-haiku-5-5",
	fable: "claude-fable-5-1",
};

/** A trailing run of `[1m]`, which Claude Code collapses to one marker. */
const TRAILING_CONTEXT_MARKER = /(\[1m\])+$/i;
/** Any `[1m]`/`[2m]` marker; Claude Code strips these before a request carries the id. */
const CONTEXT_MARKER = /\[(1|2)m\]/gi;

export function parseAnthropicModelEnv(env: Record<string, string | undefined>): AnthropicModelEnv {
	const family: Partial<Record<AnthropicModelFamily, string>> = {};
	for (const name of FAMILIES) {
		const value = env[FAMILY_ENV[name]]?.trim();
		if (value) family[name] = value;
	}
	const model = env[SESSION_MODEL_ENV]?.trim();
	const disabled = env[REMAP_DISABLE_ENV];
	return {
		...(model ? { model } : {}),
		family,
		legacyRemapDisabled: disabled !== undefined && disabled !== "",
	};
}

/**
 * Whether the variable family is in play. Without it a bare `sonnet` is an ordinary model search for pi,
 * so an operator who never set a Claude Code variable keeps the search they have.
 */
export function hasModelEnvironment(modelEnv: AnthropicModelEnv): boolean {
	return modelEnv.model !== undefined || Object.keys(modelEnv.family).length > 0;
}

/** A bare family alias, which Claude Code resolves rather than a model index. */
export function isModelAlias(name: string): boolean {
	const key = name.trim().toLowerCase();
	return FAMILIES.some((candidate) => candidate === key);
}

function familyDefault(family: AnthropicModelFamily, env: AnthropicModelEnv): string {
	return env.family[family] ?? FAMILY_DEFAULT[family];
}

function withContextSuffix(modelId: string): string {
	return `${modelId.replace(TRAILING_CONTEXT_MARKER, "")}[1m]`;
}

function resolveAliasKey(key: string, env: AnthropicModelEnv): string | undefined {
	switch (key) {
		case "opus":
			return familyDefault("opus", env);
		case "sonnet":
		case "opusplan":
			return familyDefault("sonnet", env);
		case "haiku":
			return familyDefault("haiku", env);
		case "fable":
		case "best":
			return familyDefault("fable", env);
	}
	if (RETIRED_OPUS_IDS.includes(key) && !env.legacyRemapDisabled) return familyDefault("opus", env);
	return undefined;
}

/**
 * The model id behind a Claude Code model name: the family's model for an alias, `opusplan` and `best`
 * through their family, a retired Opus id through the legacy remap, and any other name unchanged apart
 * from collapsing trailing `[1m]` runs. Callers strip the markers before the id reaches the wire.
 */
export function ccModelAlias(name: string, env: AnthropicModelEnv): string {
	const trimmed = name.trim();
	const lowered = trimmed.toLowerCase();
	const wants1m = lowered.includes("[1m]");
	const key = lowered.replace(/\[1m\]$/i, "").trim();
	const resolved = resolveAliasKey(key, env);
	if (resolved !== undefined) return wants1m ? withContextSuffix(resolved) : resolved;
	if (!wants1m) return trimmed;
	return `${trimmed.replace(TRAILING_CONTEXT_MARKER, "").trim()}[1m]`;
}

/**
 * Claude Code's startup migration for the settings `model`: exactly `sonnet[1m]` names the dated
 * Sonnet 4.5 id from before that alias meant the current default.
 */
export function ccSettingsModelMigration(name: string): string {
	return name === "sonnet[1m]" ? SONNET_1M_LEGACY : name;
}

/** The id a request carries: Claude Code never sends a `[1m]`/`[2m]` context marker. */
export function stripContextMarkers(modelId: string): string {
	return modelId.replace(CONTEXT_MARKER, "");
}
