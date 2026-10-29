/**
 * The reviewed allowlist a conformance case must stay inside, and nothing more.
 *
 * The gate's job is narrow. Before either side starts it refuses (a) an env key that would replace a
 * key the harness owns, or that is outside the reviewed key list, and (b) a top-level argv token that
 * names something outside the run's scope: an install, update, login, auth, background, remote, cloud,
 * worktree, tmux, IDE, or browser-host flag or subcommand.
 *
 * What the gate does not do is police the content a case feeds into Claude Code. Inline `--settings`
 * JSON, seeded files such as `.claude/settings.json`, and prompt text are all in scope for a case,
 * because the parity units need them: P02 seeds project settings and passes `--settings`, P08 seeds
 * hooks, P23 writes slash commands, P24 registers a plugin marketplace, P25 seeds MCP servers. A case
 * may put a SessionStart hook or a slash command in there, and a case is expected to.
 *
 * Containment is the Seatbelt profile in `isolate.ts`, not this file. Under that profile a side has no
 * real home, no keychain, no network beyond the mock model server's port, and no write outside its own
 * run root. `isolation/seeded-hook-contained` and `isolation/inline-settings-hook-contained` prove it
 * with a hook that tries all three escapes from inside settings the case supplied.
 *
 * Every entry below is a token a shipped case, PR #5 (`cc/p02-settings`), PR #6 (`cc/provider-env`),
 * or PR #7 (`cc/p03-tools`) writes in its argv. Nothing is listed for a case that might exist later: a
 * unit that needs a flag, a subcommand word, or an env key adds it here in its own reviewable diff.
 */

import { HARNESS_ENV_KEYS, type ProbeName } from "./isolate.ts";

export type ArgvProgram = "side" | ProbeName;

interface ArgvAllowlist {
	readonly flags: readonly string[];
	readonly words: readonly string[];
}

/**
 * The argv surface of the two sides, which share the Claude Code CLI. Commander dispatches the first
 * positional token as a subcommand whenever it names a registered command, and `claude --help` lists
 * only some of the registered commands, so a bare word is granted only when a case writes it.
 *
 * `-p` is spelled the way the cases spell it; `--print` returns when a case uses that spelling. A flag
 * that installs, logs in, writes settings, starts a background, remote or cloud session, loads plugin
 * code, downloads a file, or creates a worktree is absent by construction, so this list carries no
 * denylist to fall behind the binary.
 */
const SIDE_ARGV: ArgvAllowlist = {
	flags: [
		// help, version, and print
		"--help",
		"-h",
		"--version",
		"-v",
		"-p",
		// argument parsing, which is what the `cli` and `val` areas pin
		"--output-format",
		"--input-format",
		"--json-schema",
		"--max-budget-usd",
		"--effort",
		"--verbose",
		"--session-id",
		"--permission-mode",
		// model selection, which both sides share and which PR #6's cases pin
		"--model",
		// settings sources, which PR #5's cases read from the case's own roots
		"--settings",
		"--setting-sources",
		"--bare",
		"--safe-mode",
		// tool selection, which PR #7's cases pin
		"--tools",
		"--disallowedTools",
		// a token that exists to be rejected, so a case can pin the unknown-flag error
		"--no-such-flag-probe",
	],
	words: [
		// words the cases write as a prompt or as a flag value
		"help",
		"hello",
		"frobnicate-probe",
		"not-a-uuid",
		"nonsense",
		"abc",
		"json",
		"stream-json",
		// a value of `--model` in PR #6's family-alias case
		"sonnet",
		// a value of `--setting-sources` in PR #5's case
		"project",
		// the model id PR #5's `--model` case writes
		"claude-haiku-4-5",
		// the model PR #7's notice case runs, one that takes mid-conversation system messages
		"claude-opus-5-5",
		// values `--permission-mode` and `--tools` write in PR #7's cases
		"acceptEdits",
		"Read",
	],
};

/**
 * Words only the pi-cc side may run. `claude update` replaces the reference binary from Anthropic's
 * release feed, so a case that names one must declare the claude side not applicable, and the loader
 * refuses it otherwise. The pi-cc side cannot reach a feed: it has none configured and the sandbox
 * denies the network.
 */
const PI_CC_ONLY_WORDS: readonly string[] = ["update", "upgrade"];

/**
 * Each probe's own argv surface, keyed by `PROBES` so a new probe cannot ship without its list. A
 * probe runs a fixed system binary, so its flags are not Claude Code's flags.
 */
const PROBE_ARGV: Readonly<Record<ProbeName, ArgvAllowlist>> = {
	ls: { flags: ["-A"], words: [] },
	nc: { flags: ["-v", "-z", "-w"], words: [] },
	open: { flags: ["-h"], words: [] },
};

/**
 * The environment keys a case may set. The harness sets `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY`
 * for every case that starts the mock model server and a case cannot replace them, so the keys left are
 * these. The credential and header keys decorate the request the mock already receives. The model keys
 * only select a name. None of them switches provider, redirects the endpoint, or loads code, which is
 * what `CLAUDE_CODE_USE_BEDROCK`, `HTTPS_PROXY`, and `BUN_OPTIONS` would do and why they stay refused.
 */
const CASE_ENV_KEYS: readonly string[] = [
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_CUSTOM_HEADERS",
	"ANTHROPIC_MODEL",
	// PR #6 (`cc/provider-env`) resolves these five to a model name per alias.
	"ANTHROPIC_SMALL_FAST_MODEL",
	"ANTHROPIC_DEFAULT_OPUS_MODEL",
	"ANTHROPIC_DEFAULT_SONNET_MODEL",
	"ANTHROPIC_DEFAULT_HAIKU_MODEL",
	"ANTHROPIC_DEFAULT_FABLE_MODEL",
	// P39: the administrator switch `update` honors, which only a pi-cc-only case sets.
	"DISABLE_UPDATES",
	// P38 (`cc/p38-telemetry`): the operator-owned OpenTelemetry export, aimed at the mock with `$MOCK_URL`.
	"CLAUDE_CODE_ENABLE_TELEMETRY",
	"OTEL_METRICS_EXPORTER",
	"OTEL_LOGS_EXPORTER",
	"OTEL_EXPORTER_OTLP_PROTOCOL",
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_EXPORTER_OTLP_HEADERS",
	"OTEL_METRIC_EXPORT_INTERVAL",
	"OTEL_LOGS_EXPORT_INTERVAL",
	"OTEL_RESOURCE_ATTRIBUTES",
	"OTEL_LOG_USER_PROMPTS",
	"OTEL_LOG_ASSISTANT_RESPONSES",
	"OTEL_LOG_TOOL_CONTENT",
	"OTEL_LOG_TOOL_DETAILS",
	"OTEL_METRICS_INCLUDE_SESSION_ID",
	"OTEL_METRICS_INCLUDE_VERSION",
	"OTEL_METRICS_INCLUDE_ACCOUNT_UUID",
	"OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE",
	"DO_NOT_TRACK",
];

/**
 * Harness keys a case may remove. The gate otherwise forbids changing a harness-owned key, because those
 * keys are what keep the run inside the harness's control. `ANTHROPIC_API_KEY` is the exception a stored
 * or header credential needs: the harness sets it so every model case reaches the mock, and removing it
 * is how a case measures a side that has only `ANTHROPIC_AUTH_TOKEN` or a header. The mock URL stays
 * harness-owned (`ANTHROPIC_BASE_URL` is not in this list), so the request still cannot leave the sandbox.
 */
const UNSET_ENV_KEYS: readonly string[] = ["ANTHROPIC_API_KEY"];

const BARE_WORD = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** What a case may not run, or undefined. Tokens that are neither flags nor bare words are free text. */
export function argvProblem(argv: readonly string[], program: ArgvProgram, claudeRuns = true): string | undefined {
	const allowlist = program === "side" ? SIDE_ARGV : PROBE_ARGV[program];
	const name = program === "side" ? "SIDE_ARGV" : `PROBE_ARGV.${program}`;
	for (const token of argv) {
		if (token.startsWith("-")) {
			const flag = token.split("=")[0];
			if (allowlist.flags.includes(flag)) continue;
			return `argv flag "${flag}" is not in the reviewed allowlist, so add it to ${name}.flags in conformance/allowlist.ts after review`;
		}
		if (program === "side" && PI_CC_ONLY_WORDS.includes(token)) {
			if (claudeRuns) {
				return `argv word "${token}" is not in the reviewed allowlist for a case the claude side runs, so declare not_applicable.claude for the case or drop the word`;
			}
			continue;
		}
		if (!BARE_WORD.test(token) || allowlist.words.includes(token)) continue;
		return `argv word "${token}" is not in the reviewed allowlist, so add it to ${name}.words in conformance/allowlist.ts after review`;
	}
	return undefined;
}

/** What a case may not set, or undefined. A harness-owned key stays non-overridable. */
export function envProblem(env: Record<string, string>): string | undefined {
	for (const key of Object.keys(env)) {
		if (HARNESS_ENV_KEYS.includes(key)) return `env cannot replace "${key}" because the harness sets it`;
		if (CASE_ENV_KEYS.includes(key)) continue;
		return `env key "${key}" is not in the reviewed allowlist, so add it to CASE_ENV_KEYS in conformance/allowlist.ts after review`;
	}
	return undefined;
}

/** What a case may not remove, or undefined. Only the reviewed list, never an arbitrary harness key. */
export function unsetProblem(unset: readonly string[]): string | undefined {
	for (const key of unset) {
		if (UNSET_ENV_KEYS.includes(key)) continue;
		return `unset names "${key}", which is not in the reviewed list, so add it to UNSET_ENV_KEYS in conformance/allowlist.ts after review`;
	}
	return undefined;
}
