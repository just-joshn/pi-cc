/**
 * `ANTHROPIC_MODEL` and the per-family model variables, the model half of Claude Code's provider env.
 *
 * A family variable pins what one of Claude Code's aliases resolves to, so `ANTHROPIC_MODEL=haiku` asks
 * for whatever `ANTHROPIC_DEFAULT_HAIKU_MODEL` names. `ANTHROPIC_SMALL_FAST_MODEL` is deliberately not a
 * source here: the pinned 2.1.312 does not read it for the session model, it only names the small model
 * behind background tasks (`provider-env/small-fast-is-not-the-session-model`).
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

export function parseAnthropicModelEnv(env: Record<string, string | undefined>): AnthropicModelEnv {
	const family: Partial<Record<AnthropicModelFamily, string>> = {};
	for (const name of FAMILIES) {
		const value = env[FAMILY_ENV[name]]?.trim();
		if (value) family[name] = value;
	}
	const model = env[SESSION_MODEL_ENV]?.trim();
	return { ...(model ? { model } : {}), family };
}

/** Claude Code's alias for a model name, else the name unchanged. */
export function ccModelAlias(name: string, env: AnthropicModelEnv): string {
	const key = name.trim().toLowerCase();
	const family = FAMILIES.find((candidate) => candidate === key);
	if (family === undefined) return name;
	return env.family[family] ?? name;
}
