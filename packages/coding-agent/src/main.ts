/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { type ImageContent, modelsAreEqual } from "@earendil-works/pi-ai";
import { setCapabilityOverrides, setInternalSpawnEnv } from "@earendil-works/pi-tui";
import chalk from "chalk";
import {
	type Args,
	formatVersionLine,
	type Mode,
	NOT_LOGGED_IN_MESSAGE,
	normalizeSessionName,
	PRINT_INPUT_REQUIRED_MESSAGE,
	parseArgs,
	printHelp,
} from "./cli/args.ts";
import {
	type AuthCheckResult,
	checkProviderAuth,
	createAuthCheckModelRuntime,
	getProviderCredential,
} from "./cli/auth-check.ts";
import {
	type AuthCommand,
	AuthCommandError,
	getAuthCommandName,
	getAuthCommandUsage,
	isAuthCommandHelp,
	parseAuthCommand,
	printAuthCommandHelp,
	validateAuthCommandArgs,
} from "./cli/auth-command.ts";
import { formatDiagnosticPrefix, validateSessionId } from "./cli/cc-flags.ts";
import { resolveCredentialForPrint } from "./cli/credential-print.ts";
import { processFileArguments } from "./cli/file-processor.ts";
import { buildInitialMessage } from "./cli/initial-message.ts";
import { listModels } from "./cli/list-models.ts";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import { selectSession } from "./cli/session-picker.ts";
import { shouldRunFirstTimeSetup, showFirstTimeSetup, showStartupSelector } from "./cli/startup-ui.ts";
import { APP_NAME, ENV_SESSION_DIR, expandTildePath, getAgentDir, getPackageDir, VERSION } from "./config.ts";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "./core/agent-session-runtime.ts";
import {
	type AgentSessionRuntimeDiagnostic,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/agent-session-services.ts";
import { ccSettingsSessionModel } from "./core/anthropic-model-env.ts";
import { formatNoApiKeyFoundMessage, formatNoModelsAvailableMessage } from "./core/auth-guidance.ts";
import { AuthStorage, ReadOnlyAuthStorage } from "./core/auth-storage.ts";
import { exportFromFile } from "./core/export-html/index.ts";
import type { InlineExtension } from "./core/extensions/types.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { anthropicCcModel, resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.ts";
import { ModelRuntime } from "./core/model-runtime.ts";
import { flushRawStdout, restoreStdout, takeOverStdout, writeRawStdout } from "./core/output-guard.ts";
import {
	type AppMode,
	readInitialProjectTrust,
	readProjectTrust,
	resolveProjectTrusted,
} from "./core/project-trust.ts";
import type { CreateAgentSessionOptions } from "./core/sdk.ts";
import {
	formatMissingSessionCwdPrompt,
	getMissingSessionCwdIssue,
	MissingSessionCwdError,
	type SessionCwdIssue,
} from "./core/session-cwd.ts";
import { SessionManager } from "./core/session-manager.ts";
import { ccEffectiveEnv } from "./core/settings/cc/env.ts";
import { withAdditionalDirectories } from "./core/settings/cc/merge.ts";
import {
	formatIgnoredProjectSettings,
	formatSettingsFailures,
	formatSkippedSettings,
} from "./core/settings/cc/report.ts";
import {
	admitCcDirectory,
	type CcDirectoryAdmission,
	type CcRunLocation,
	type CcRunSettings,
	type CcSettleResult,
	openCcRunSettings,
} from "./core/settings/cc/run.ts";
import { resolveCcTuiSettings } from "./core/settings/cc/tui.ts";
import type { CcSettings } from "./core/settings/cc/types.ts";
import { collectSettingsDiagnostics, deduplicateDiagnostics } from "./core/settings-diagnostics.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { printTimings, resetTimings, time } from "./core/timings.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
import { builtInExtensions } from "./extensions/index.ts";
import { loadMcpCommand } from "./extensions/mcp/cli.lazy.ts";
import { runMigrations, showDeprecationWarnings } from "./migrations.ts";
import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.ts";
import { initTheme, setThemeJsonValidator, stopThemeWatcher } from "./modes/interactive/theme/theme.ts";
import { validateThemeJson } from "./modes/interactive/theme/theme-schema.ts";
import { STREAM_JSON_REQUIRES_VERBOSE, sdkFlagProblem, sdkOutputFormat } from "./modes/sdk/flags.ts";
import { cleanupManagedInstall, handleConfigCommand, handlePackageCommand } from "./package-manager-cli.ts";
import { captureStartupEnv, startupEnv } from "./utils/internal-env.ts";
import { isLocalPath, normalizePath, resolvePath } from "./utils/paths.ts";
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.ts";

const EXTENSION_LOAD_FAILURE_HINT = `Hint: Start without extensions using "${APP_NAME} -ne".`;

const CC_BARE_TOOLS: readonly string[] = ["read", "edit", "bash"];

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin(): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		console.error(color(`${formatDiagnosticPrefix(diagnostic)}${diagnostic.message}`));
	}
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function toSettingSources(value: string | undefined): string[] | undefined {
	return value
		?.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function ccRunLocation(parsed: Args, cwd: string): CcRunLocation {
	return {
		cwd,
		home: homedir(),
		env: process.env,
		platform: process.platform,
		version: VERSION,
		settingSources: toSettingSources(parsed.settingSources),
		flagSettings: parsed.settings,
	};
}

function openCcSettingsForRun(parsed: Args, cwd: string, trust: boolean | "pending"): CcRunSettings {
	const run = openCcRunSettings(ccRunLocation(parsed, cwd), trust);
	if (run.flagError !== undefined) {
		console.error(chalk.red(`Error: ${run.flagError}`));
		process.exit(1);
	}
	reportCcSettings(run);
	if (run.refusal !== undefined) {
		console.error(chalk.red(run.refusal));
		process.exit(1);
	}
	applyCcEnv(ccRunSettings(run.settings, parsed));
	return run;
}

function ccRunSettings(settings: CcSettings, parsed: Args): CcSettings {
	return withAdditionalDirectories(settings, parsed.addDir ?? []);
}

function reportCcSettings(report: CcSettleResult): void {
	const blocks = [
		...formatSettingsFailures(report.failures),
		...formatSkippedSettings(report.skipped),
		...formatIgnoredProjectSettings(report.ignored),
	];
	for (const line of blocks) {
		console.error(chalk.dim(line));
	}
}

function repoTierReport(run: CcRunSettings): CcSettleResult {
	const isRepo = (source: string) => source === "project" || source === "local";
	return {
		settings: run.settings,
		failures: run.failures.filter((failure) => isRepo(failure.source)),
		skipped: run.skipped.filter((skip) => isRepo(skip.source)),
		ignored: run.ignored,
	};
}

function applyCcEnv(settings: CcSettings): void {
	const effectiveEnv = ccEffectiveEnv(process.env, settings);
	for (const [name, value] of Object.entries(effectiveEnv)) {
		if (process.env[name] !== value) {
			process.env[name] = value;
		}
	}
}

export function ccResourceSuppression(parsed: Args): {
	noExtensions: boolean;
	noSkills: boolean;
	noPromptTemplates: boolean;
	noContextFiles: boolean;
	noMemory: boolean;
	noMcp: boolean;
} {
	const bare = parsed.bare === true;
	const safeMode = parsed.safeMode === true;
	return {
		noExtensions: parsed.noExtensions === true || bare || safeMode,
		noSkills: parsed.noSkills === true || bare || safeMode,
		noPromptTemplates: parsed.noPromptTemplates === true || safeMode,
		noContextFiles: parsed.noContextFiles === true || bare,
		// --safe-mode drops Claude Code memory but keeps pi's AGENTS.md context files.
		noMemory: bare || safeMode,
		// --safe-mode names MCP servers among the customizations it disables; --bare does not.
		noMcp: parsed.noMcp === true || parsed.safeMode === true,
	};
}

function resolveAppMode(parsed: Args, stdinIsTTY: boolean, stdoutIsTTY: boolean): AppMode {
	if (parsed.mode === "rpc") {
		return "rpc";
	}
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY || !stdoutIsTTY) {
		return "print";
	}
	return "interactive";
}

/** Claude Code reports its ask-first mode as `default`; the flag spells it `manual`. */
function sdkPermissionMode(flag: string | undefined): string {
	return flag === undefined || flag === "manual" ? "default" : flag;
}

function toPrintOutputMode(appMode: AppMode): Exclude<Mode, "rpc"> {
	return appMode === "json" ? "json" : "text";
}

function isPlainRuntimeMetadataCommand(parsed: Args): boolean {
	return !parsed.print && parsed.mode === undefined && (parsed.help === true || parsed.listModels !== undefined);
}

async function runAuthCommand(args: string[]): Promise<boolean> {
	if (isAuthCommandHelp(args)) {
		printAuthCommandHelp();
		return true;
	}

	let command: AuthCommand | undefined;
	try {
		command = parseAuthCommand(args);
	} catch (error) {
		const message = error instanceof AuthCommandError ? error.message : "Failed to parse auth command";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
	if (!command) return false;

	const parsed = parseArgs(command.args);
	if (parsed.unknownFlags.size > 0) {
		const option = parsed.unknownFlags.keys().next().value;
		console.error(chalk.red(`Unknown option --${option} for "${getAuthCommandName(command.kind)}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getAuthCommandUsage(command.kind)}".`));
		process.exitCode = 1;
		return true;
	}
	try {
		if (parsed.diagnostics.length > 0) {
			throw new AuthCommandError(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
		}
		if (command.kind !== "check") {
			const signal = AbortSignal.timeout(15_000);
			const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, signal });
			const credential = await resolveCredentialForPrint(
				parsed,
				modelRuntime,
				command.kind,
				command.minExpiryMs,
				signal,
			);
			process.stdout.write(`${credential}\n`);
			return true;
		}

		const requestedAuth = validateAuthCommandArgs(parsed, command.kind);
		let result: AuthCheckResult;
		let credential: string | undefined;
		try {
			const credentials = command.noRefresh ? new ReadOnlyAuthStorage() : AuthStorage.create();
			const modelRuntime = await createAuthCheckModelRuntime(credentials);
			result = await checkProviderAuth(parsed, modelRuntime, { refresh: !command.noRefresh });
			if (command.credentials && result.status === "ready") {
				credential = await getProviderCredential(result.provider, modelRuntime, credentials, {
					refresh: !command.noRefresh,
				});
				if (!credential) {
					result = { status: "not_ready", provider: result.provider, reason: "credential_not_available" };
				}
			}
		} catch {
			result = {
				status: "invalid",
				provider: requestedAuth.provider ?? requestedAuth.model!,
				reason: "invalid_state",
			};
		}
		const output = command.json
			? JSON.stringify({ ...result, ...(credential ? { credentials: credential } : {}) })
			: (credential ?? result.status);
		process.stdout.write(`${output}\n`);
		process.exitCode = result.status === "ready" ? 0 : result.status === "not_ready" ? 1 : 2;
	} catch (error) {
		const message = error instanceof AuthCommandError ? error.message : "Failed to resolve credential";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = command.kind === "check" ? 2 : 1;
	}
	return true;
}

async function prepareInitialMessage(
	parsed: Args,
	stdinContent?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	// AgentSession resizes these after extension hooks select the request model.
	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages: false });
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

/** Result from resolving a session argument */
type ResolvedSession =
	| { type: "path"; path: string } // Direct file path
	| { type: "local"; path: string } // Found in current project
	| { type: "global"; path: string; cwd: string } // Found in different project
	| { type: "not_found"; arg: string }; // Not found anywhere

/**
 * Resolve a session argument to a file path.
 * If it looks like a path, use as-is. Otherwise try to match as session ID prefix.
 */
function findLocalSessionByExactId(
	sessionId: string,
	cwd: string,
	sessionDir?: string,
): { type: "local"; path: string } | undefined {
	const path = SessionManager.findById(cwd, sessionId, sessionDir);
	return path ? { type: "local", path } : undefined;
}

async function resolveSessionPath(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	// If it looks like a file path, resolve it before handing it to the session manager.
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		return { type: "path", path: resolvePath(sessionArg, cwd) };
	}

	// Exact IDs only require reading session headers. Fall back to the full
	// metadata listing for prefix matches.
	const exactLocalMatch = findLocalSessionByExactId(sessionArg, cwd, sessionDir);
	if (exactLocalMatch) {
		return exactLocalMatch;
	}

	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatch = localSessions.find((s) => s.id.startsWith(sessionArg));

	if (localMatch) {
		return { type: "local", path: localMatch.path };
	}

	// Try global search across all projects
	const allSessions = await SessionManager.listAll(sessionDir);
	const globalMatch =
		allSessions.find((s) => s.id === sessionArg) ?? allSessions.find((s) => s.id.startsWith(sessionArg));

	if (globalMatch) {
		return { type: "global", path: globalMatch.path, cwd: globalMatch.cwd };
	}

	// Not found anywhere
	return { type: "not_found", arg: sessionArg };
}

/** Prompt user for yes/no confirmation */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

function validateForkFlags(parsed: Args): void {
	if (!parsed.fork) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}
}

function validateSessionIdFlags(parsed: Args): void {
	if (parsed.sessionId === undefined) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --session-id cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}

	// Claude Code validates the id only when it creates a session, so `--help` and pi's metadata
	// commands never reject it.
	if (parsed.help || parsed.noSession || parsed.listModels !== undefined) return;

	const rejected = validateSessionId(parsed.sessionId);
	if (rejected !== undefined) {
		console.error(chalk.red(`${formatDiagnosticPrefix(rejected)}${rejected.message}`));
		process.exit(1);
	}
}

function openSessionOrExit(path: string, sessionDir?: string): SessionManager {
	try {
		return SessionManager.open(path, sessionDir);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

function forkSessionOrExit(sourcePath: string, cwd: string, sessionDir?: string, sessionId?: string): SessionManager {
	try {
		return SessionManager.forkFrom(sourcePath, cwd, sessionDir, { id: sessionId });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

export async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
	settingsManager: SettingsManager,
): Promise<SessionManager> {
	if (parsed.noSession || parsed.help || parsed.listModels !== undefined) {
		return SessionManager.inMemory(cwd, parsed.sessionId !== undefined ? { id: parsed.sessionId } : undefined);
	}

	if (parsed.fork) {
		if (parsed.sessionId) {
			const existingTarget = findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
			if (existingTarget) {
				console.error(chalk.red(`Session already exists with id '${parsed.sessionId}'`));
				process.exit(1);
			}
		}

		const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
			case "global":
				return forkSessionOrExit(resolved.path, cwd, sessionDir, parsed.sessionId);

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.session) {
		const resolved = await resolveSessionPath(parsed.session, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
				return openSessionOrExit(resolved.path, sessionDir);

			case "global": {
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return forkSessionOrExit(resolved.path, cwd, sessionDir);
			}

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.resume) {
		try {
			const selectedPath = await selectSession(
				(onProgress, signal) => SessionManager.list(cwd, sessionDir, onProgress, signal),
				(onProgress, signal) => SessionManager.listAll(sessionDir, onProgress, signal),
				settingsManager,
			);
			if (!selectedPath) {
				console.log(chalk.dim("No session selected"));
				process.exit(0);
			}
			return SessionManager.open(selectedPath, sessionDir);
		} finally {
			stopThemeWatcher();
		}
	}

	if (parsed.continue) {
		return SessionManager.continueRecent(cwd, sessionDir);
	}

	if (parsed.sessionId) {
		const existingSession = findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
		if (existingSession) {
			return SessionManager.open(existingSession.path, sessionDir);
		}
		console.error(
			chalk.yellow(
				`Warning: No project session found with id '${parsed.sessionId}'; creating a new session with that id.`,
			),
		);
	}

	return SessionManager.create(cwd, sessionDir, { id: parsed.sessionId });
}

/** Claude Code's session model: `ANTHROPIC_MODEL`, then the settings `model`. */
function ccSessionModel(settings: CcSettings): { name: string; source: string } | undefined {
	const envModel = process.env.ANTHROPIC_MODEL?.trim();
	if (envModel) return { name: envModel, source: "ANTHROPIC_MODEL" };
	const name = ccSettingsSessionModel(settings.model, settings.sources.get("model"));
	if (!name) return undefined;
	return { name, source: "Claude Code settings" };
}

function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRuntime: ModelRuntime,
	settingsManager: SettingsManager,
	ccModel: { name: string; source: string } | undefined,
): {
	options: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
} {
	const options: CreateAgentSessionOptions = {};
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	let cliThinkingFromModel = false;

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	if (parsed.provider && !parsed.model) {
		diagnostics.push({
			type: "error",
			message: `--provider requires --model (for example: --provider ${parsed.provider} --model <pattern>)`,
		});
	}
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			cliThinking: parsed.thinking,
			inlineApiKey: Boolean(parsed.apiKey),
			modelRuntime,
		});
		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}
		if (resolved.model) {
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			// Explicit --thinking still takes precedence (applied later).
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	if (!options.model && ccModel !== undefined) {
		// Claude Code sends its model to the Anthropic endpoint, so another provider's look-alike must not
		// claim it. Without Anthropic auth the name is an ordinary pi model search.
		const anthropicModel = anthropicCcModel(modelRuntime, ccModel.name);
		const selected = anthropicModel
			? { model: anthropicModel, error: undefined }
			: resolveCliModel({ cliModel: ccModel.name, modelRuntime });
		if (selected.model === undefined) {
			diagnostics.push({
				type: "warning",
				message: `Model "${ccModel.name}" from ${ccModel.source} did not resolve (${selected.error ?? "no match"}). Using the default model.`,
			});
		} else {
			options.model = selected.model;
		}
	}

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		// Check if saved default is in scoped models - use it if so, otherwise first scoped model
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRuntime.getModel(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// Use thinking level from scoped model config if explicitly set
			if (!parsed.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// Use thinking level from first scoped model if explicitly set
			if (!parsed.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// Thinking level from CLI (takes precedence over scoped model thinking levels set above)
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}

	// Scoped models for Ctrl+P cycling
	// Keep thinking level undefined when not explicitly set in the model pattern.
	// Undefined means "inherit current session thinking level" during cycling.
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// API key from CLI - set as a non-persistent runtime override
	// (handled by caller before createAgentSession)

	// Tools
	// Claude Code's --bare keeps Bash, Edit and Read and nothing else, and offers no placeholder.
	if (parsed.bare === true) {
		options.fixedTools = true;
		if (!parsed.tools) {
			options.tools = [...CC_BARE_TOOLS];
		}
	} else if (parsed.noTools) {
		options.noTools = "all";
	} else if (parsed.noBuiltinTools) {
		options.noTools = "builtin";
	}
	if (parsed.tools) {
		options.tools = [...parsed.tools];
	}
	if (parsed.excludeTools) {
		options.excludeTools = [...parsed.excludeTools];
	}

	return { options, cliThinkingFromModel, diagnostics };
}

function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}

async function promptForMissingSessionCwd(
	issue: SessionCwdIssue,
	settingsManager: SettingsManager,
): Promise<string | undefined> {
	return showStartupSelector(settingsManager, formatMissingSessionCwdPrompt(issue), [
		{ label: "Continue", value: issue.fallbackCwd },
		{ label: "Cancel", value: undefined },
	]);
}

export interface MainOptions {
	extensionFactories?: InlineExtension[];
}

export async function main(args: string[], options?: MainOptions) {
	resetTimings();
	// Commands and startup selectors can load user-authored themes before runtime creation.
	setThemeJsonValidator(validateThemeJson);
	const extensionFactories = [...builtInExtensions, ...(options?.extensionFactories ?? [])];
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.PI_OFFLINE);
	if (offlineMode) {
		process.env.PI_OFFLINE = "1";
		process.env.PI_SKIP_VERSION_CHECK = "1";
	}
	captureStartupEnv();
	setInternalSpawnEnv(startupEnv());

	if (await runAuthCommand(args)) {
		return;
	}

	if (process.platform === "win32") {
		cleanupWindowsSelfUpdateQuarantine(getPackageDir());
	}
	cleanupManagedInstall();

	let cwd: string;
	try {
		cwd = process.cwd();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		console.error(
			chalk.red(
				"Error: The current working directory no longer exists. Change to an existing directory and try again.",
			),
		);
		process.exit(1);
	}
	const agentDir = getAgentDir();
	const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher();

	if (await handlePackageCommand(args, { extensionFactories })) {
		const exitCode = process.exitCode ?? 0;
		if (process.platform === "win32" && exitCode === 0 && args[0] === "update") {
			// We normally prefer process.exit(0) for package commands so bad extensions cannot keep
			// one-shot commands alive. On Windows, Node can assert after fetch() if process.exit(0)
			// runs during teardown; let successful `pi update` drain naturally instead.
			// https://github.com/nodejs/node/issues/56645
			return;
		}
		process.exit(exitCode);
		return;
	}

	if (await handleConfigCommand(args, { extensionFactories })) {
		return;
	}

	if (args[0] === "mcp") {
		const { runMcpCommand } = await loadMcpCommand();
		process.exitCode = await runMcpCommand(args.slice(1), { cwd, agentDir });
		return;
	}

	const parsed = parseArgs(args);
	if (parsed.diagnostics.length > 0) {
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${formatDiagnosticPrefix(d)}${d.message}`));
		}
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			process.exit(1);
		}
	}
	time("parseArgs");

	if (parsed.version) {
		console.log(formatVersionLine());
		process.exit(0);
	}

	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
	const shouldTakeOverStdout = appMode !== "interactive" && !isPlainRuntimeMetadataCommand(parsed);
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	validateForkFlags(parsed);
	validateSessionIdFlags(parsed);
	const sdkProblem = sdkFlagProblem({
		mode: parsed.mode,
		outputFormat: parsed.outputFormat,
		inputFormat: parsed.inputFormat,
		includePartialMessages: parsed.includePartialMessages,
		replayUserMessages: parsed.replayUserMessages,
	});
	if (sdkProblem !== undefined) {
		console.error(chalk.red(sdkProblem));
		process.exit(1);
	}
	const sdkFormat = sdkOutputFormat(parsed);
	const sdkStreamInput = sdkFormat !== undefined && parsed.inputFormat === "stream-json";

	const trustPromptMode: AppMode = parsed.help || parsed.listModels !== undefined ? "print" : appMode;

	const trustStore = new ProjectTrustStore(agentDir);
	const readTrust = (directory: string): boolean | "pending" =>
		readInitialProjectTrust({
			cwd: directory,
			trustStore,
			trustOverride: parsed.projectTrustOverride,
			defaultProjectTrust: bootstrapSettingsManager.getDefaultProjectTrust(),
			hasUI: trustPromptMode === "interactive",
		});
	// Pending withholds every repo tier until the runtime directory is known. Opening the startup
	// directory as already decided would report or admit its files before --session can select another.
	let ccAdmission: CcDirectoryAdmission = {
		cwd,
		run: openCcSettingsForRun(parsed, cwd, "pending"),
	};
	const bindCcDirectory = (directory: string, trust: boolean | "pending"): void => {
		const result = admitCcDirectory(ccAdmission, ccRunLocation(parsed, directory), directory, trust);
		ccAdmission = result.admission;
		if (result.opened) {
			if (result.admission.run.flagError !== undefined) {
				console.error(chalk.red(`Error: ${result.admission.run.flagError}`));
				process.exit(1);
			}
			reportCcSettings(repoTierReport(result.admission.run));
			if (result.admission.run.refusal !== undefined) {
				console.error(chalk.red(result.admission.run.refusal));
				process.exit(1);
			}
			applyCcEnv(ccRunSettings(result.admission.run.settings, parsed));
			return;
		}
		if (result.settled) {
			reportCcSettings(result.settled);
			applyCcEnv(ccRunSettings(result.settled.settings, parsed));
		}
	};
	time("ccSettings");

	// Run migrations (pass cwd for project-local migrations)
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(cwd);
	time("runMigrations");

	const startupSettingsManager = SettingsManager.create(cwd, agentDir);
	const startupSettingsDiagnostics = collectSettingsDiagnostics(startupSettingsManager);

	// Experimental first-time setup: theme choice and analytics opt-in.
	// Runs before any runtime services are created so the chosen settings apply everywhere.
	if (appMode === "interactive" && !parsed.help && parsed.listModels === undefined && shouldRunFirstTimeSetup()) {
		await showFirstTimeSetup(startupSettingsManager);
		time("firstTimeSetup");
	}

	if (appMode === "interactive" && parsed.useTheme !== undefined) {
		startupSettingsManager.applyOverrides({ theme: parsed.useTheme });
	}

	// Decide the final runtime cwd before creating cwd-bound runtime services.
	// --session and --resume may select a session from another project, so project-local
	// settings, resources, provider registrations, and models must be resolved only after
	// the target session cwd is known. The startup-cwd settings manager is used only for
	// sessionDir lookup during session selection.
	const envSessionDir = process.env[ENV_SESSION_DIR];
	const sessionDir =
		(parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
		(envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
		startupSettingsManager.getSessionDir();
	let sessionManager = await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager);
	const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
	if (missingSessionCwdIssue) {
		if (appMode === "interactive") {
			const selectedCwd = await promptForMissingSessionCwd(missingSessionCwdIssue, startupSettingsManager);
			if (!selectedCwd) {
				process.exit(0);
			}
			sessionManager = SessionManager.open(missingSessionCwdIssue.sessionFile!, sessionDir, selectedCwd);
		} else {
			console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
			process.exit(1);
		}
	}
	if (parsed.name !== undefined) {
		const name = normalizeSessionName(parsed.name);
		if (name === undefined) {
			console.error(chalk.red("Error: --name requires a non-empty value"));
			process.exit(1);
		}
		sessionManager.appendSessionInfo(name);
	}
	time("createSessionManager");

	const sessionCwd = sessionManager.getCwd();
	bindCcDirectory(sessionCwd, readTrust(sessionCwd));
	const autoTrustOnReloadCwd =
		parsed.projectTrustOverride === undefined && !hasTrustRequiringProjectResources(sessionCwd)
			? sessionCwd
			: undefined;
	const projectTrustByCwd = new Map<string, boolean>();

	const resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions);
	const resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
	const resolvedPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates);
	const resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
		projectTrustContext,
	}) => {
		const isInitialRuntime = sessionStartEvent === undefined;
		const projectTrustDiagnostics: AgentSessionRuntimeDiagnostic[] = [];
		const cachedProjectTrust = projectTrustByCwd.get(cwd);
		const hasTrustRequiringResources = hasTrustRequiringProjectResources(cwd);
		const shouldResolveProjectTrust =
			parsed.projectTrustOverride === undefined && cachedProjectTrust === undefined && hasTrustRequiringResources;
		const projectTrusted = shouldResolveProjectTrust
			? false
			: (cachedProjectTrust ??
				parsed.projectTrustOverride ??
				(!hasTrustRequiringResources || trustStore.get(cwd) === true));
		if (cwd !== ccAdmission.cwd) {
			bindCcDirectory(cwd, shouldResolveProjectTrust ? "pending" : projectTrusted);
		} else if (!shouldResolveProjectTrust) {
			bindCcDirectory(cwd, projectTrusted);
		}
		const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
		const ccResources = ccResourceSuppression(parsed);
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager: runtimeSettingsManager,
			modelRuntimeSignal: AbortSignal.timeout(15_000),
			extensionFlagValues: parsed.unknownFlags,
			resourceLoaderReloadOptions: shouldResolveProjectTrust
				? {
						resolveProjectTrust: async ({ extensionsResult }) => {
							const trusted = await resolveProjectTrusted({
								cwd,
								trustStore,
								trustOverride: parsed.projectTrustOverride,
								defaultProjectTrust: startupSettingsManager.getDefaultProjectTrust(),
								extensionsResult,
								projectTrustContext:
									projectTrustContext ??
									createProjectTrustContext({
										cwd,
										mode: isInitialRuntime ? trustPromptMode : appMode,
										settingsManager: startupSettingsManager,
										hasUI: isInitialRuntime && trustPromptMode === "interactive",
									}),
								onExtensionError: (message) => projectTrustDiagnostics.push({ type: "warning", message }),
							});
							projectTrustByCwd.set(cwd, trusted);
							bindCcDirectory(cwd, trusted);
							return trusted;
						},
					}
				: undefined,
			resourceLoaderOptions: {
				additionalExtensionPaths: resolvedExtensionPaths,
				additionalSkillPaths: resolvedSkillPaths,
				additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
				additionalThemePaths: resolvedThemePaths,
				...ccResources,
				memorySettings: () => {
					const trust = readProjectTrust({
						cwd,
						trustStore,
						trustOverride: parsed.projectTrustOverride,
						defaultProjectTrust: startupSettingsManager.getDefaultProjectTrust(),
					});
					return {
						values: ccAdmission.run.settings.values,
						pluginOptions: ccAdmission.run.settings.pluginOptions,
						settingSources: toSettingSources(parsed.settingSources),
						trustDecision: trust.kind === "decided" ? trust.trusted : undefined,
					};
				},
				disabledBuiltinExtensions: ccResources.noMcp ? ["mcp"] : undefined,
				noThemes: parsed.noThemes,
				systemPrompt: parsed.systemPrompt,
				appendSystemPrompt: parsed.appendSystemPrompt,
				extensionFactories,
			},
		});
		const { settingsManager, modelRuntime, resourceLoader } = services;
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [
			...projectTrustDiagnostics,
			...services.diagnostics,
			...collectSettingsDiagnostics(settingsManager),
			...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
				type: "error" as const,
				message: `Failed to load extension "${path}": ${error}`,
			})),
			...(resourceLoader.getExtensions().warnings ?? []).map(({ path, warning }) => ({
				type: "warning" as const,
				message: `Extension package "${path}": ${warning}`,
			})),
		];

		const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
		const scopedModels =
			modelPatterns && modelPatterns.length > 0
				? await resolveModelScope(modelPatterns, modelRuntime, { signal: AbortSignal.timeout(15_000) })
				: [];
		const {
			options: sessionOptions,
			cliThinkingFromModel,
			diagnostics: sessionOptionDiagnostics,
		} = buildSessionOptions(
			parsed,
			scopedModels,
			sessionManager.buildSessionContext().messages.length > 0,
			modelRuntime,
			settingsManager,
			ccSessionModel(ccAdmission.run.settings),
		);
		diagnostics.push(...sessionOptionDiagnostics);

		if (parsed.apiKey) {
			if (!sessionOptions.model) {
				diagnostics.push({
					type: "error",
					message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
				});
			} else {
				await modelRuntime.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
			}
		}

		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: sessionOptions.model,
			thinkingLevel: sessionOptions.thinkingLevel,
			scopedModels: sessionOptions.scopedModels,
			tools: sessionOptions.tools,
			fixedTools: sessionOptions.fixedTools,
			excludeTools: sessionOptions.excludeTools,
			noTools: sessionOptions.noTools,
			customTools: sessionOptions.customTools,
		});
		const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
		if (created.session.model && cliThinkingOverride) {
			created.session.setThinkingLevel(created.session.thinkingLevel);
		}

		return {
			...created,
			services,
			diagnostics,
		};
	};
	time("createRuntime");
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir,
		sessionManager,
	});
	time("createAgentSessionRuntime");
	const { services, session, modelFallbackMessage } = runtime;
	const { settingsManager, modelRuntime, resourceLoader } = services;
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

	const startupDiagnostics = deduplicateDiagnostics([...startupSettingsDiagnostics, ...runtime.diagnostics]);
	const hasRuntimeErrors = runtime.diagnostics.some((diagnostic) => diagnostic.type === "error");

	if (parsed.help) {
		reportDiagnostics(startupDiagnostics);
		const extensionFlags = resourceLoader
			.getExtensions()
			.extensions.flatMap((extension) => Array.from(extension.flags.values()));
		printHelp(extensionFlags);
		process.exit(0);
	}

	if (parsed.listModels !== undefined) {
		reportDiagnostics(startupDiagnostics);
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		await listModels(modelRuntime, searchPattern, AbortSignal.timeout(15_000));
		process.exit(0);
	}

	// Read piped stdin content (if any) - skip for RPC mode which uses stdin for JSON-RPC
	let stdinContent: string | undefined;
	if (appMode !== "rpc" && !sdkStreamInput) {
		stdinContent = await readPipedStdin();
		if (stdinContent !== undefined && appMode === "interactive") {
			appMode = "print";
		}
	}
	time("readPipedStdin");

	const { initialMessage, initialImages } = await prepareInitialMessage(parsed, stdinContent);
	time("prepareInitialMessage");
	initTheme(settingsManager.getTheme(), appMode === "interactive");
	time("initTheme");

	// Show deprecation warnings in interactive mode
	if (appMode === "interactive" && deprecationWarnings.length > 0) {
		await showDeprecationWarnings(deprecationWarnings);
	}

	time("resolveModelScope");
	if (appMode !== "interactive" || hasRuntimeErrors) {
		reportDiagnostics(startupDiagnostics);
	}
	if (hasRuntimeErrors) {
		if (runtime.diagnostics.some((diagnostic) => diagnostic.message.includes("Failed to load extension"))) {
			console.error(chalk.yellow(EXTENSION_LOAD_FAILURE_HINT));
		}
		process.exit(1);
	}
	time("createAgentSession");

	if (
		(appMode === "print" || appMode === "json") &&
		!sdkStreamInput &&
		initialMessage === undefined &&
		parsed.messages.length === 0
	) {
		console.error(chalk.red(PRINT_INPUT_REQUIRED_MESSAGE));
		process.exit(1);
	}

	if (sdkFormat === "stream-json" && !parsed.verbose) {
		console.error(chalk.red(STREAM_JSON_REQUIRES_VERBOSE));
		process.exit(1);
	}

	const model = session.model;
	if ((appMode === "print" || appMode === "json") && model === undefined) {
		console.error(chalk.red(formatNoModelsAvailableMessage()));
		process.exit(1);
	}

	// Claude Code prints its not-logged-in line on stdout in text mode, where stdout is human output.
	// The SDK host reports the missing credential as frames, and pi's JSON mode reports it through pi's own path.
	if (
		appMode === "print" &&
		sdkFormat === undefined &&
		model !== undefined &&
		!modelRuntime.hasConfiguredAuth(model.provider)
	) {
		writeRawStdout(`${NOT_LOGGED_IN_MESSAGE}\n`);
		await flushRawStdout();
		console.error(chalk.red(formatNoApiKeyFoundMessage(model.provider)));
		process.exit(1);
	}

	const startupBenchmark = isTruthyEnvFlag(process.env.PI_STARTUP_BENCHMARK);
	if (startupBenchmark && appMode !== "interactive") {
		console.error(chalk.red("Error: PI_STARTUP_BENCHMARK only supports interactive mode"));
		process.exit(1);
	}

	// RPC refreshes catalogs here in the background; interactive mode starts its refresh after TUI initialization.
	if (!offlineMode && appMode === "rpc") {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15_000);
		void modelRuntime
			.refresh({ signal: controller.signal })
			.catch(() => {})
			.finally(() => clearTimeout(timeout));
	}

	if (appMode === "rpc") {
		printTimings();
		await runRpcMode(runtime);
	} else if (appMode === "interactive") {
		const interactiveMode = new InteractiveMode(runtime, {
			migratedProviders,
			startupDiagnostics,
			modelFallbackMessage,
			autoTrustOnReloadCwd,
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			verbose: parsed.verbose,
			tuiMode: parsed.tuiMode,
			initialThemeSetting: parsed.useTheme,
			ccTui: () =>
				resolveCcTuiSettings(ccRunSettings(ccAdmission.run.settings, parsed), {
					axScreenReaderFlag: parsed.axScreenReader === true,
					env: process.env,
				}),
		});
		if (startupBenchmark) {
			await interactiveMode.init();
			time("interactiveMode.init");
			// Give the TUI's stdin handler a brief chance to consume terminal query replies
			// (Kitty keyboard protocol, device attributes, cell size) before restoring the terminal.
			await new Promise((resolve) => setTimeout(resolve, 150));
			interactiveMode.stop();
			stopThemeWatcher();
			printTimings();
			if (process.stdout.writableLength > 0) {
				await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
			}
			if (process.stderr.writableLength > 0) {
				await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
			}
			return;
		}

		printTimings();
		await interactiveMode.run();
	} else {
		printTimings();
		const printOptions = {
			messages: parsed.messages,
			initialMessage,
			initialImages,
		};
		const exitCode = await runPrintMode(
			runtime,
			sdkFormat === undefined
				? { ...printOptions, mode: toPrintOutputMode(appMode) }
				: {
						...printOptions,
						mode: "sdk",
						sdk: {
							outputFormat: sdkFormat,
							inputFormat: parsed.inputFormat === "stream-json" ? "stream-json" : "text",
							verbose: parsed.verbose === true,
							includePartial: parsed.includePartialMessages === true,
							replayUser: parsed.replayUserMessages === true,
							permissionMode: sdkPermissionMode(parsed.permissionMode),
							authConfigured: model !== undefined && modelRuntime.hasConfiguredAuth(model.provider),
							input: process.stdin,
							env: process.env,
						},
					},
		);
		stopThemeWatcher();
		restoreStdout();
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
		return;
	}
}
