/**
 * The reviewed allowlist a conformance case must stay inside. The Seatbelt profile in `isolate.ts` is
 * the boundary; this list is the second line, so that a case cannot reach a Claude Code command path
 * that writes to the machine even when `claude --help` never mentions it.
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
 * only some of the registered commands, so the loader grants reviewed words instead of trying to name
 * the rest. Left out on purpose: `--bg`/`--background`, `--worktree`/`-w`, `--cloud`, `--teleport`,
 * `--from-pr`, `--remote-control*`, `--plugin-dir`, `--plugin-url`, `--file`, `--desktop`,
 * `--chrome`, `--ide`, `--environment`, `--tmux`, and every `--update` form.
 */
const SIDE_ARGV: ArgvAllowlist = {
	flags: [
		// the end-of-flags separator. The tokens after it are still checked one at a time.
		"--",
		// help, version, and print
		"--help",
		"-h",
		"--version",
		"-v",
		"--print",
		"-p",
		// argument parsing and stream shape, which is what most cases pin
		"--output-format",
		"--input-format",
		"--json-schema",
		"--max-budget-usd",
		"--effort",
		"--verbose",
		// session and model selection, all reads
		"--session-id",
		"--continue",
		"-c",
		"--resume",
		"-r",
		"--fork-session",
		"--model",
		"--fallback-model",
		"--name",
		"-n",
		"--no-session-persistence",
		// prompt and tool configuration for one run
		"--system-prompt",
		"--append-system-prompt",
		"--system-prompt-snapshot",
		"--tools",
		"--allowedTools",
		"--allowed-tools",
		"--disallowedTools",
		"--disallowed-tools",
		"--add-dir",
		"--agent",
		"--agents",
		"--betas",
		"--autocompact",
		"--prompt-suggestions",
		"--brief",
		"--disable-slash-commands",
		"--exclude-dynamic-system-prompt-sections",
		"--include-hook-events",
		"--include-partial-messages",
		"--replay-user-messages",
		"--forward-subagent-text",
		"--ax-screen-reader",
		"--no-chrome",
		// permission policy for one run
		"--permission-mode",
		"--permission-prompts",
		"--dangerously-skip-permissions",
		"--allow-dangerously-skip-permissions",
		"--restricted",
		"--safe-mode",
		"--bare",
		// settings and MCP sources, which a case reads from its own temp roots
		"--settings",
		"--setting-sources",
		"--mcp-config",
		"--strict-mcp-config",
		// debug output, which the profile confines to the case's roots
		"--debug",
		"-d",
		"--debug-file",
		// read-only flags of the `agents` and `logs` subcommands, absent from `claude --help`
		"--json",
		"--all",
		// a token that exists to be rejected, so a case can pin the unknown-flag error
		"--no-such-flag-probe",
	],
	words: [
		// read-only subcommand paths
		"mcp",
		"list",
		"get",
		"agents",
		"auto-mode",
		"config",
		"defaults",
		"critique",
		"logs",
		"doctor",
		// words the shipped cases write as a prompt or as a flag value
		"help",
		"hello",
		"frobnicate-probe",
		"not-a-uuid",
		"nonsense",
		"abc",
		"json",
		"text",
		"stream-json",
		"high",
		// an id a read-only subcommand reads
		"probe",
	],
};

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
 * for every case that starts the mock model server and a case cannot replace them, so the keys a case
 * can still want are these three.
 */
const CASE_ENV_KEYS: readonly string[] = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_MODEL"];

const BARE_WORD = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** What a case may not run, or undefined. Tokens that are neither flags nor bare words are free text. */
export function argvProblem(argv: readonly string[], program: ArgvProgram): string | undefined {
	const allowlist = program === "side" ? SIDE_ARGV : PROBE_ARGV[program];
	const name = program === "side" ? "SIDE_ARGV" : `PROBE_ARGV.${program}`;
	for (const token of argv) {
		if (token.startsWith("-")) {
			const flag = token.split("=")[0];
			if (allowlist.flags.includes(flag)) continue;
			return `argv flag "${flag}" is not in the reviewed allowlist, so add it to ${name}.flags in conformance/allowlist.ts after review`;
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
