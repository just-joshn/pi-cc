/** The `system/init` frame, and the session facts it and the `initialize` control response both report. */

import { randomUUID } from "node:crypto";
import { VERSION } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
import { declaredToolName } from "../../core/tools/cc-surface.ts";
import type { SystemInitFrame } from "./frames.ts";

export interface SlashCommandFact {
	name: string;
	description: string;
	argumentHint: string;
	builtin: boolean;
}

/** What the session reports about itself, read once per turn so a model or mode change shows. */
export interface SessionFacts {
	cwd: string;
	sessionId: string;
	tools: string[];
	model: string;
	permissionMode: string;
	slashCommands: SlashCommandFact[];
	skills: string[];
	apiKeySource: string;
	autoMemoryDir: string | undefined;
}

/** Claude Code names which credential reached the API: `none` without one. */
export function apiKeySourceOf(authConfigured: boolean, env: NodeJS.ProcessEnv): string {
	if (!authConfigured) return "none";
	if (env.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY";
	if (env.ANTHROPIC_AUTH_TOKEN) return "ANTHROPIC_AUTH_TOKEN";
	return "oauth";
}

export function readSessionFacts(
	session: AgentSession,
	state: { permissionMode: string; authConfigured: boolean },
	env: NodeJS.ProcessEnv,
): SessionFacts {
	const templates = session.promptTemplates.map((template) => ({
		name: template.name,
		description: template.description,
		argumentHint: "",
		builtin: false,
	}));
	const extensionCommands = session.extensionRunner.getRegisteredCommands().map((command) => ({
		name: command.invocationName,
		description: command.description ?? "",
		argumentHint: "",
		builtin: false,
	}));
	const skills = session.resourceLoader.getSkills().skills;
	return {
		cwd: session.sessionManager.getCwd(),
		sessionId: session.sessionId,
		tools: session.getActiveToolNames().map(declaredToolName),
		model: session.model?.id ?? "",
		permissionMode: state.permissionMode,
		slashCommands: [
			...BUILTIN_SLASH_COMMANDS.map((command) => ({
				name: command.name,
				description: command.description,
				argumentHint: command.argumentHint ?? "",
				builtin: true,
			})),
			...extensionCommands,
			...templates,
			...skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				argumentHint: "",
				builtin: false,
			})),
		],
		skills: skills.map((skill) => skill.name),
		apiKeySource: apiKeySourceOf(state.authConfigured, env),
		autoMemoryDir: session.resourceLoader.getMemory().autoMemoryDir,
	};
}

/** Claude Code's `system/init` frame, the first frame of every turn. */
export function buildInitFrame(facts: SessionFacts): SystemInitFrame {
	return {
		type: "system",
		subtype: "init",
		cwd: facts.cwd,
		session_id: facts.sessionId,
		tools: facts.tools,
		mcp_servers: [],
		model: facts.model,
		permissionMode: facts.permissionMode,
		slash_commands: facts.slashCommands.map((command) => command.name),
		terminal_slash_commands: [],
		apiKeySource: facts.apiKeySource,
		claude_code_version: VERSION,
		output_style: "default",
		agents: [],
		skills: facts.skills,
		plugins: [],
		capabilities: [],
		analytics_disabled: true,
		product_feedback_disabled: true,
		uuid: randomUUID(),
		memory_paths: facts.autoMemoryDir === undefined ? {} : { auto: facts.autoMemoryDir },
		original_cwd: facts.cwd,
		additional_directories: [],
		fast_mode_state: "off",
		fast_mode_disabled_reason: "sdk_opt_in_required",
		per_turn_effort_active: false,
		view_mode: "default",
	};
}
