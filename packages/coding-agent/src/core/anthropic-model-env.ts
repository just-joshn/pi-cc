/**
 * `ANTHROPIC_MODEL` and the per-family model variables, the model half of Claude Code's provider env.
 *
 * `ANTHROPIC_MODEL` names the session model and may use one of Claude Code's family aliases. A family
 * variable pins what that alias resolves to, and with no variable set the alias means the model the
 * pinned build ships as that family's default. Any other name is a model id: Claude Code sends it as
 * written, including a name it has never heard of, rather than refusing the run.
 *
 * `ANTHROPIC_SMALL_FAST_MODEL` is deliberately not a source here: the pinned 2.1.312 does not read it for
 * the session model, it only names the small model behind background tasks
 * (`provider-env/small-fast-is-not-the-session-model`).
 */

const SESSION_MODEL_ENV = "ANTHROPIC_MODEL";
const FAMILIES = ["opus", "sonnet", "haiku", "fable"] as const;

export type AnthropicModelFamily = (typeof FAMILIES)[number];

export interface AnthropicModelEnv {
	model?: string;
	family: Partial<Record<AnthropicModelFamily, string>>;
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
	sonnet: "claude-sonnet-4-6",
	haiku: "claude-haiku-4-5",
	fable: "claude-fable-5-1",
};

export function parseAnthropicModelEnv(env: Record<string, string | undefined>): AnthropicModelEnv {
	const family: Partial<Record<AnthropicModelFamily, string>> = {};
	for (const name of FAMILIES) {
		const value = env[FAMILY_ENV[name]]?.trim();
		if (value) family[name] = value;
	}
	const model = env[SESSION_MODEL_ENV]?.trim();
	return { ...(model ? { model } : {}), family };
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

/** Claude Code's model for `name`: the family's model for an alias, the name unchanged otherwise. */
export function ccModelAlias(name: string, env: AnthropicModelEnv): string {
	const key = name.trim().toLowerCase();
	const family = FAMILIES.find((candidate) => candidate === key);
	if (family === undefined) return name;
	return env.family[family] ?? FAMILY_DEFAULT[family];
}
