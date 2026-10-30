/** The Claude Code flags pi-cc accepts, and the rendering rules its argument errors use. */

export type CcValue = string | boolean | string[] | undefined;

export interface CcDiagnostic {
	type: "warning" | "error";
	message: string;
	style?: "cli";
}

export interface CcFlags {
	// Also pi's own flag; the table validates it as a UUID.
	sessionId?: string;

	outputFormat?: string;
	inputFormat?: string;
	permissionMode?: string;
	permissionPrompts?: string;
	effort?: string;
	jsonSchema?: unknown;
	maxBudgetUsd?: number;
	maxTurns?: number;
	settingSources?: string;
	systemPromptSnapshot?: string;
	autocompact?: string;
	debug?: string | true;
	debugFile?: string;
	addDir?: string[];
	agent?: string;
	agents?: string;
	allowedTools?: string[];
	disallowedTools?: string[];
	betas?: string[];
	cloud?: string;
	environment?: string;
	fallbackModel?: string;
	file?: string[];
	fromPr?: string;
	mcpConfig?: string[];
	pluginDir?: string[];
	pluginUrl?: string[];
	promptSuggestions?: string;
	remoteControl?: string;
	remoteControlSessionNamePrefix?: string;
	settings?: string;
	teleport?: string;
	worktree?: string;
	allowDangerouslySkipPermissions?: boolean;
	axScreenReader?: boolean;
	bg?: boolean;
	bare?: boolean;
	brief?: boolean;
	chrome?: boolean;
	dangerouslySkipPermissions?: boolean;
	desktop?: boolean;
	disableSlashCommands?: boolean;
	excludeDynamicSystemPromptSections?: boolean;
	forkSession?: boolean;
	forwardSubagentText?: boolean;
	ide?: boolean;
	includeHookEvents?: boolean;
	includePartialMessages?: boolean;
	noChrome?: boolean;
	noSessionPersistence?: boolean;
	replayUserMessages?: boolean;
	restricted?: boolean;
	safeMode?: boolean;
	strictMcpConfig?: boolean;
	tmux?: boolean;
}

interface CcFlagBase {
	name: string;
	aliases?: string[];
	short?: string[];
	choices?: { values: string[]; hard: true };
	summary: string;
	/** Claude Code accepts the flag but leaves it out of `--help`. */
	hidden?: true;
	status: "wired" | "accepted";
	/**
	 * Stores the value. Absent when pi's own branches already own the flag;
	 * such rows are documented in help but not matched by the table parser.
	 */
	apply?: (value: CcValue, target: CcFlags) => void;
	validate?: (value: string) => CcDiagnostic | undefined;
}

export type CcFlag = CcFlagBase &
	({ arity: "boolean" } | { arity: "value" | "optional-value" | "variadic"; placeholder: string });

type BooleanField = {
	[K in keyof CcFlags]-?: CcFlags[K] extends boolean | undefined ? K : never;
}[keyof CcFlags];
type StringField = {
	[K in keyof CcFlags]-?: CcFlags[K] extends string | undefined ? K : never;
}[keyof CcFlags];
type ListField = {
	[K in keyof CcFlags]-?: CcFlags[K] extends string[] | undefined ? K : never;
}[keyof CcFlags];

function setBoolean(field: BooleanField) {
	return (_value: CcValue, target: CcFlags): void => {
		target[field] = true;
	};
}

function setString(field: StringField) {
	return (value: CcValue, target: CcFlags): void => {
		if (typeof value === "string") {
			target[field] = value;
		}
	};
}

function appendList(field: ListField) {
	return (value: CcValue, target: CcFlags): void => {
		const values = Array.isArray(value) ? value : [];
		target[field] = [...(target[field] ?? []), ...values];
	};
}

function cliError(message: string): CcDiagnostic {
	return { type: "error", style: "cli", message };
}

function choicesError(flag: CcFlag, values: readonly string[], value: string): CcDiagnostic {
	return cliError(
		`option '${formatCcFlagSpec(flag)}' argument '${value}' is invalid. Allowed choices are ${values.join(", ")}.`,
	);
}

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const SETTING_SOURCES = ["user", "project", "local"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateEffort(value: string): CcDiagnostic | undefined {
	if (EFFORT_LEVELS.includes(value)) {
		return undefined;
	}
	return {
		type: "warning",
		message: `Unknown --effort value '${value}' — ignoring it and using the default effort. Valid values: ${EFFORT_LEVELS.join(", ")}.`,
	};
}

export function validateSessionId(value: string): CcDiagnostic | undefined {
	if (UUID_PATTERN.test(value)) {
		return undefined;
	}
	return { type: "error", message: "Invalid session ID. Must be a valid UUID." };
}

function validateMaxBudget(value: string): CcDiagnostic | undefined {
	const amount = Number(value);
	if (Number.isFinite(amount) && amount > 0) {
		return undefined;
	}
	return cliError(
		`option '--max-budget-usd <amount>' argument '${value}' is invalid. --max-budget-usd must be a positive number greater than 0`,
	);
}

function validateMaxTurns(value: string): CcDiagnostic | undefined {
	if (!Number.isNaN(Number(value))) {
		return undefined;
	}
	return cliError(`option '--max-turns <turns>' argument '${value}' is invalid. must be a number`);
}

function validateJsonSchema(value: string): CcDiagnostic | undefined {
	try {
		JSON.parse(value);
		return undefined;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { type: "error", message: `--json-schema is not valid JSON: ${detail}` };
	}
}

function validateSettingSources(value: string): CcDiagnostic | undefined {
	const invalid = value
		.split(",")
		.map((source) => source.trim())
		.filter((source) => source.length > 0 && !SETTING_SOURCES.includes(source));
	if (invalid.length === 0) {
		return undefined;
	}
	return {
		type: "error",
		message: `Invalid setting source: ${invalid[0]}. Valid options are: ${SETTING_SOURCES.join(", ")}`,
	};
}

function applyDebug(value: CcValue, target: CcFlags): void {
	target.debug = typeof value === "string" ? value : true;
}

function applyJsonSchema(value: CcValue, target: CcFlags): void {
	target.jsonSchema = JSON.parse(String(value));
}

function applyMaxBudget(value: CcValue, target: CcFlags): void {
	target.maxBudgetUsd = Number(value);
}

function applyMaxTurns(value: CcValue, target: CcFlags): void {
	target.maxTurns = Number(value);
}

/** The Claude Code flag surface, in the order Claude Code prints it. */
export const CC_FLAGS: CcFlag[] = [
	{
		name: "add-dir",
		arity: "variadic",
		placeholder: "directories",
		summary: "Extra directories tools may touch",
		status: "accepted",
		apply: appendList("addDir"),
	},
	{
		name: "agent",
		arity: "value",
		placeholder: "agent",
		summary: "Named agent config for this session",
		status: "accepted",
		apply: setString("agent"),
	},
	{
		name: "agents",
		arity: "value",
		placeholder: "json-or-file",
		summary: "Custom agent definitions as JSON or a file",
		status: "accepted",
		apply: setString("agents"),
	},
	{
		name: "allow-dangerously-skip-permissions",
		arity: "boolean",
		summary: "Offer permission bypass without enabling it",
		status: "accepted",
		apply: setBoolean("allowDangerouslySkipPermissions"),
	},
	{
		name: "allowedTools",
		aliases: ["allowed-tools"],
		arity: "variadic",
		placeholder: "tools",
		summary: "Tool allowlist for this run",
		status: "accepted",
		apply: appendList("allowedTools"),
	},
	{
		name: "append-system-prompt",
		arity: "value",
		placeholder: "prompt",
		summary: "Append text to the system prompt (repeatable)",
		status: "wired",
	},
	{
		name: "autocompact",
		arity: "value",
		placeholder: "auto|tokens",
		summary: "Context compaction window size",
		status: "accepted",
		apply: setString("autocompact"),
	},
	{
		name: "ax-screen-reader",
		arity: "boolean",
		summary: "Flat output for screen readers",
		status: "accepted",
		apply: setBoolean("axScreenReader"),
	},
	{
		name: "bg",
		aliases: ["background"],
		arity: "boolean",
		summary: "Run the session in the background",
		status: "accepted",
		apply: setBoolean("bg"),
	},
	{
		name: "bare",
		arity: "boolean",
		summary: "Minimal mode: no hooks, plugins, or context files",
		status: "wired",
		apply: setBoolean("bare"),
	},
	{
		name: "betas",
		arity: "variadic",
		placeholder: "betas",
		summary: "Extra API beta header values",
		status: "accepted",
		apply: appendList("betas"),
	},
	{
		name: "brief",
		arity: "boolean",
		summary: "Enable the agent-to-user message tool",
		status: "accepted",
		apply: setBoolean("brief"),
	},
	{
		name: "chrome",
		arity: "boolean",
		summary: "Enable the Chrome integration",
		status: "accepted",
		apply: setBoolean("chrome"),
	},
	{
		name: "cloud",
		arity: "optional-value",
		placeholder: "description|session_id|url",
		summary: "Create or attach a cloud session",
		status: "accepted",
		apply: setString("cloud"),
	},
	{
		name: "continue",
		short: ["c"],
		arity: "boolean",
		summary: "Continue the previous session",
		status: "wired",
	},
	{
		name: "dangerously-skip-permissions",
		arity: "boolean",
		summary: "Bypass every permission check",
		status: "accepted",
		apply: setBoolean("dangerouslySkipPermissions"),
	},
	{
		name: "debug",
		short: ["d"],
		arity: "optional-value",
		placeholder: "filter",
		summary: "Debug logging with an optional filter",
		status: "accepted",
		apply: applyDebug,
	},
	{
		name: "debug-file",
		arity: "value",
		placeholder: "path",
		summary: "Write debug logs to a file",
		status: "accepted",
		apply: setString("debugFile"),
	},
	{
		name: "desktop",
		arity: "boolean",
		summary: "Open the session in the desktop app",
		status: "accepted",
		apply: setBoolean("desktop"),
	},
	{
		name: "disable-slash-commands",
		arity: "boolean",
		summary: "Disable skills and slash commands",
		status: "accepted",
		apply: setBoolean("disableSlashCommands"),
	},
	{
		name: "disallowedTools",
		aliases: ["disallowed-tools"],
		arity: "variadic",
		placeholder: "tools",
		summary: "Tool denylist for this run",
		status: "accepted",
		apply: appendList("disallowedTools"),
	},
	{
		name: "effort",
		arity: "value",
		placeholder: "level",
		summary: "Reasoning effort for this session",
		status: "accepted",
		validate: validateEffort,
		apply: setString("effort"),
	},
	{
		name: "environment",
		arity: "value",
		placeholder: "environment_id",
		summary: "Self-hosted environment for a cloud session",
		status: "accepted",
		apply: setString("environment"),
	},
	{
		name: "exclude-dynamic-system-prompt-sections",
		arity: "boolean",
		summary: "Move machine-specific prompt parts to the first message",
		status: "accepted",
		apply: setBoolean("excludeDynamicSystemPromptSections"),
	},
	{
		name: "fallback-model",
		arity: "value",
		placeholder: "model",
		summary: "Models to try when the primary is unavailable",
		status: "accepted",
		apply: setString("fallbackModel"),
	},
	{
		name: "file",
		arity: "variadic",
		placeholder: "specs",
		summary: "Files to download at startup",
		status: "accepted",
		apply: appendList("file"),
	},
	{
		name: "fork-session",
		arity: "boolean",
		summary: "Fork into a new session ID when resuming",
		status: "accepted",
		apply: setBoolean("forkSession"),
	},
	{
		name: "forward-subagent-text",
		arity: "boolean",
		summary: "Forward subagent text as messages",
		status: "accepted",
		apply: setBoolean("forwardSubagentText"),
	},
	{
		name: "from-pr",
		arity: "optional-value",
		placeholder: "value",
		summary: "Resume the session linked to a pull request",
		status: "accepted",
		apply: setString("fromPr"),
	},
	{
		name: "help",
		short: ["h"],
		arity: "boolean",
		summary: "Show this help",
		status: "wired",
	},
	{
		name: "ide",
		arity: "boolean",
		summary: "Connect to an available IDE",
		status: "accepted",
		apply: setBoolean("ide"),
	},
	{
		name: "include-hook-events",
		arity: "boolean",
		summary: "Include hook lifecycle events in the stream",
		status: "accepted",
		apply: setBoolean("includeHookEvents"),
	},
	{
		name: "include-partial-messages",
		arity: "boolean",
		summary: "Include partial message chunks in the stream",
		status: "wired",
		apply: setBoolean("includePartialMessages"),
	},
	{
		name: "input-format",
		arity: "value",
		placeholder: "format",
		choices: { values: ["text", "stream-json"], hard: true },
		summary: "Prompt input format (text, stream-json)",
		status: "wired",
		apply: setString("inputFormat"),
	},
	{
		name: "json-schema",
		arity: "value",
		placeholder: "schema",
		summary: "JSON Schema for structured output",
		status: "accepted",
		validate: validateJsonSchema,
		apply: applyJsonSchema,
	},
	{
		name: "max-budget-usd",
		arity: "value",
		placeholder: "amount",
		summary: "Spend cap in dollars for this run",
		status: "accepted",
		validate: validateMaxBudget,
		apply: applyMaxBudget,
	},
	{
		name: "max-turns",
		arity: "value",
		placeholder: "turns",
		summary: "Maximum number of agentic turns in non-interactive mode",
		hidden: true,
		status: "wired",
		validate: validateMaxTurns,
		apply: applyMaxTurns,
	},
	{
		name: "mcp-config",
		arity: "variadic",
		placeholder: "configs",
		summary: "MCP servers from files or JSON strings",
		status: "accepted",
		apply: appendList("mcpConfig"),
	},
	{
		name: "model",
		arity: "value",
		placeholder: "model",
		summary: "Model pattern or ID",
		status: "wired",
	},
	{
		name: "name",
		short: ["n"],
		arity: "value",
		placeholder: "name",
		summary: "Session display name",
		status: "wired",
	},
	{
		name: "no-chrome",
		arity: "boolean",
		summary: "Disable the Chrome integration",
		status: "accepted",
		apply: setBoolean("noChrome"),
	},
	{
		name: "no-session-persistence",
		arity: "boolean",
		summary: "Do not save the session to disk",
		status: "accepted",
		apply: setBoolean("noSessionPersistence"),
	},
	{
		name: "output-format",
		arity: "value",
		placeholder: "format",
		choices: { values: ["text", "json", "stream-json"], hard: true },
		summary: "Output format (text, json, stream-json)",
		status: "wired",
		apply: setString("outputFormat"),
	},
	{
		name: "permission-mode",
		arity: "value",
		placeholder: "mode",
		choices: {
			values: ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"],
			hard: true,
		},
		summary: "Permission mode for the session",
		status: "accepted",
		apply: setString("permissionMode"),
	},
	{
		name: "permission-prompts",
		arity: "value",
		placeholder: "target",
		choices: { values: ["host", "none"], hard: true },
		summary: "Who answers permission prompts (host, none)",
		status: "accepted",
		apply: setString("permissionPrompts"),
	},
	{
		name: "plugin-dir",
		arity: "value",
		placeholder: "path",
		summary: "Load a plugin directory or zip",
		status: "accepted",
		apply: appendList("pluginDir"),
	},
	{
		name: "plugin-url",
		arity: "value",
		placeholder: "url",
		summary: "Load a plugin zip from a URL",
		status: "accepted",
		apply: appendList("pluginUrl"),
	},
	{
		name: "print",
		short: ["p"],
		arity: "boolean",
		summary: "Non-interactive mode: process prompt and exit",
		status: "wired",
	},
	{
		name: "prompt-suggestions",
		arity: "optional-value",
		placeholder: "value",
		summary: "Predict the next user prompt",
		status: "accepted",
		apply: setString("promptSuggestions"),
	},
	{
		name: "remote-control",
		arity: "optional-value",
		placeholder: "name",
		summary: "Interactive session with remote control",
		status: "accepted",
		apply: setString("remoteControl"),
	},
	{
		name: "remote-control-session-name-prefix",
		arity: "value",
		placeholder: "prefix",
		summary: "Prefix for remote control session names",
		status: "accepted",
		apply: setString("remoteControlSessionNamePrefix"),
	},
	{
		name: "replay-user-messages",
		arity: "boolean",
		summary: "Echo stdin user messages on stdout",
		status: "wired",
		apply: setBoolean("replayUserMessages"),
	},
	{
		name: "restricted",
		arity: "boolean",
		summary: "Restricted mode: no command tools, tighter file scope",
		status: "accepted",
		apply: setBoolean("restricted"),
	},
	{
		name: "resume",
		short: ["r"],
		arity: "optional-value",
		placeholder: "value",
		summary: "Resume a session by ID, or pick one",
		status: "wired",
	},
	{
		name: "safe-mode",
		arity: "boolean",
		summary: "Start with all customizations disabled",
		status: "wired",
		apply: setBoolean("safeMode"),
	},
	{
		name: "session-id",
		arity: "value",
		placeholder: "uuid",
		summary: "Exact session ID, created if missing",
		status: "wired",
		apply: setString("sessionId"),
	},
	{
		name: "setting-sources",
		arity: "value",
		placeholder: "sources",
		summary: "Setting sources to load (user, project, local)",
		status: "wired",
		validate: validateSettingSources,
		apply: setString("settingSources"),
	},
	{
		name: "settings",
		arity: "value",
		placeholder: "file-or-json",
		summary: "Extra settings from a file or JSON string",
		status: "wired",
		apply: setString("settings"),
	},
	{
		name: "strict-mcp-config",
		arity: "boolean",
		summary: "Use only MCP servers from --mcp-config",
		status: "accepted",
		apply: setBoolean("strictMcpConfig"),
	},
	{
		name: "system-prompt",
		arity: "value",
		placeholder: "prompt",
		summary: "System prompt for this session",
		status: "wired",
	},
	{
		name: "system-prompt-snapshot",
		arity: "value",
		placeholder: "on|off",
		choices: { values: ["on", "off"], hard: true },
		summary: "Record the system prompt once per conversation",
		status: "accepted",
		apply: setString("systemPromptSnapshot"),
	},
	{
		name: "teleport",
		arity: "optional-value",
		placeholder: "session",
		summary: "Resume a teleport session",
		status: "accepted",
		apply: setString("teleport"),
	},
	{
		name: "tmux",
		arity: "boolean",
		summary: "Create a tmux session for the worktree",
		status: "accepted",
		apply: setBoolean("tmux"),
	},
	{
		name: "tools",
		arity: "variadic",
		placeholder: "tools",
		summary: "Comma-separated tool allowlist",
		status: "wired",
	},
	{
		name: "verbose",
		arity: "boolean",
		summary: "Verbose startup output",
		status: "wired",
	},
	{
		name: "version",
		short: ["v"],
		arity: "boolean",
		summary: "Show version number",
		status: "wired",
	},
	{
		name: "worktree",
		short: ["w"],
		arity: "optional-value",
		placeholder: "name",
		summary: "Create a git worktree for this session",
		status: "accepted",
		apply: setString("worktree"),
	},
];

export interface CcMatch {
	flag: CcFlag;
	inlineValue?: string;
}

const CC_FLAG_INDEX = new Map<string, CcFlag>();
for (const flag of CC_FLAGS) {
	if (!flag.apply) {
		continue;
	}
	for (const token of [flag.name, ...(flag.aliases ?? []), ...(flag.short ?? [])]) {
		CC_FLAG_INDEX.set(token, flag);
	}
}

function formatCcFlagSpec(flag: CcFlag): string {
	switch (flag.arity) {
		case "boolean":
			return `--${flag.name}`;
		case "value":
			return `--${flag.name} <${flag.placeholder}>`;
		case "optional-value":
			return `--${flag.name} [${flag.placeholder}]`;
		case "variadic":
			return `--${flag.name} <${flag.placeholder}...>`;
	}
}

export function matchCcFlag(token: string): CcMatch | undefined {
	if (!token.startsWith("-")) {
		return undefined;
	}
	const body = token.startsWith("--") ? token.slice(2) : token.slice(1);
	const eqIndex = body.indexOf("=");
	const name = eqIndex === -1 ? body : body.slice(0, eqIndex);
	const flag = CC_FLAG_INDEX.get(name);
	if (!flag) {
		return undefined;
	}
	return { flag, inlineValue: eqIndex === -1 ? undefined : body.slice(eqIndex + 1) };
}

export function consumeCcFlag(
	match: CcMatch,
	argv: string[],
	index: number,
	target: CcFlags,
	diagnostics: CcDiagnostic[],
): number {
	const { flag, inlineValue } = match;
	let lastIndex = index;
	let value: CcValue;

	switch (flag.arity) {
		case "boolean": {
			value = true;
			break;
		}
		case "value": {
			if (inlineValue !== undefined) {
				value = inlineValue;
			} else if (index + 1 < argv.length) {
				value = argv[index + 1];
				lastIndex = index + 1;
			} else {
				diagnostics.push(cliError(`option '${formatCcFlagSpec(flag)}' argument missing`));
				return lastIndex;
			}
			break;
		}
		case "optional-value": {
			if (inlineValue !== undefined) {
				value = inlineValue;
			} else if (index + 1 < argv.length && !argv[index + 1].startsWith("-")) {
				value = argv[index + 1];
				lastIndex = index + 1;
			}
			break;
		}
		case "variadic": {
			const values: string[] = [];
			if (inlineValue !== undefined) {
				values.push(inlineValue);
			} else {
				let next = index + 1;
				while (next < argv.length && !argv[next].startsWith("-")) {
					values.push(argv[next]);
					next++;
				}
				lastIndex = next - 1;
			}
			if (values.length === 0) {
				diagnostics.push(cliError(`option '${formatCcFlagSpec(flag)}' argument missing`));
				return lastIndex;
			}
			value = values;
			break;
		}
	}

	if (typeof value === "string") {
		const choices = flag.choices;
		if (choices && !choices.values.includes(value)) {
			diagnostics.push(choicesError(flag, choices.values, value));
			return lastIndex;
		}
		const rejected = flag.validate?.(value);
		if (rejected) {
			diagnostics.push(rejected);
			return lastIndex;
		}
	}

	if (flag.status === "accepted") {
		const message = `--${flag.name} is accepted but not implemented yet`;
		if (!diagnostics.some((entry) => entry.message === message)) {
			diagnostics.push({ type: "warning", message });
		}
	}

	flag.apply?.(value, target);
	return lastIndex;
}

function formatCcFlagLabel(flag: CcFlag): string {
	const spellings = [...(flag.short ?? []).map((name) => `-${name}`), `--${flag.name}`];
	for (const alias of flag.aliases ?? []) {
		spellings.push(`--${alias}`);
	}
	const label = `  ${spellings.join(", ")}`;
	switch (flag.arity) {
		case "boolean":
			return label;
		case "value":
			return `${label} <${flag.placeholder}>`;
		case "optional-value":
			return `${label} [${flag.placeholder}]`;
		case "variadic":
			return `${label} <${flag.placeholder}...>`;
	}
}

/** The message Claude Code prints for a flag it does not know. */
export function formatUnknownOptionMessage(token: string): string {
	return `unknown option '${token}'`;
}

/**
 * The prefix pi prints before a diagnostic message.
 *
 * `style: "cli"` marks an argument error, which Claude Code renders as a
 * lowercase `error:` with no `Error: ` prefix.
 */
export function formatDiagnosticPrefix(diagnostic: { type: "info" | "warning" | "error"; style?: "cli" }): string {
	if (diagnostic.style === "cli") {
		return "error: ";
	}
	if (diagnostic.type === "error") {
		return "Error: ";
	}
	return diagnostic.type === "warning" ? "Warning: " : "";
}

const CC_HELP_LABEL_WIDTH = 34;

/**
 * The `Claude Code compatibility options` help section, generated from the table.
 *
 * Every entry keeps at least four spaces before its summary so a reader (and
 * the conformance help parser) can split the label from the text.
 */
export function formatCcHelpSection(): string {
	return CC_FLAGS.filter((flag) => !flag.hidden)
		.map((flag) => {
			const label = formatCcFlagLabel(flag);
			return `${label.padEnd(Math.max(CC_HELP_LABEL_WIDTH, label.length + 4))}${flag.summary}`;
		})
		.join("\n");
}
