/** The Claude Code profile prompt: identity and working text for the system blocks, session-specific text that can move to the first user message, and machine context for the message after it. */

import type { NormalizedBuildSystemPromptOptions } from "../system-prompt.ts";
import { buildSystemPromptSections } from "../system-prompt.ts";
import type { CcEnvironment } from "./environment.ts";
import {
	CC_CONTEXT_GUIDANCE,
	CC_IDENTITY,
	CC_IDENTITY_APPENDED,
	CC_MEMORY_DISABLED,
	CC_MEMORY_ENABLED,
	CC_SESSION_GUIDANCE,
	CC_WORKING_APPEND_PREFIX,
	CC_WORKING_SECTIONS,
} from "./sections.ts";

export interface CcPromptRecord {
	identity: string;
	working: string;
	/** Session-specific part of the working prompt, which `--exclude-dynamic-system-prompt-sections` moves to the first user message. */
	dynamic?: string;
	/** Machine context for the message after the first user message. Absent under `--bare`. */
	context?: string;
}

export interface CcPromptMode {
	bare: boolean;
}

/** Sections of pi's own prompt that the Claude Code profile replaces, drops, or places in the session-specific part. */
const PI_ONLY_SECTIONS = new Set([
	"preamble",
	"tools",
	"docs",
	"addendum",
	"cwd",
	"memory",
	"project_context",
	"skills",
]);

/**
 * Assemble the prompt record. An appended instruction lands in the working prompt, and the identity
 * line only notes that it follows. A custom prompt replaces the working prompt, session-specific part
 * included. Bare keeps the identity, reduces the working prompt to the directory and date, and sends no
 * context.
 */
export function assembleCcPrompt(
	options: NormalizedBuildSystemPromptOptions,
	mode: CcPromptMode,
	environment: CcEnvironment,
): CcPromptRecord {
	const appended = options.appendSystemPrompt;
	const identity = appended ? `${CC_IDENTITY}${CC_IDENTITY_APPENDED}` : CC_IDENTITY;
	const withAppended = (text: string) => (appended ? `${text}${CC_WORKING_APPEND_PREFIX}${appended}` : text);
	if (mode.bare) {
		const working = options.customPrompt ?? `CWD: ${environment.cwd}\nDate: ${environment.date}`;
		return { identity, working: withAppended(working) };
	}
	const context = renderContext(options, environment);
	if (options.customPrompt !== undefined) return { identity, working: withAppended(options.customPrompt), context };
	return {
		identity,
		working: withAppended(CC_WORKING_SECTIONS.join("\n\n")),
		dynamic: renderDynamic(options),
		context,
	};
}

function renderDynamic(options: NormalizedBuildSystemPromptOptions): string {
	const memory = options.sections.memory;
	const memorySection = memory ? `${CC_MEMORY_ENABLED}\n\n${memory}` : CC_MEMORY_DISABLED;
	const { project_context: projectContext, skills } = buildSystemPromptSections({
		...options,
		customPrompt: undefined,
	});
	return [
		CC_SESSION_GUIDANCE,
		memorySection,
		...(projectContext ? [projectContext] : []),
		...(skills ? [skills] : []),
	].join("\n\n");
}

function renderContext(options: NormalizedBuildSystemPromptOptions, environment: CcEnvironment): string {
	const piSections = buildSystemPromptSections({ ...options, customPrompt: undefined });
	const parts = [renderEnvironment(environment)];
	if (piSections.rules) parts.push(piSections.rules);
	parts.push(...CC_CONTEXT_GUIDANCE);
	for (const [name, text] of Object.entries(piSections)) {
		if (!PI_ONLY_SECTIONS.has(name) && name !== "rules") parts.push(text);
	}
	return parts.join("\n\n");
}

function renderEnvironment(environment: CcEnvironment): string {
	return [
		"# Environment",
		"This session runs in the following environment:",
		` - Working directory: ${environment.cwd.replace(/\\/g, "/")}`,
		` - Inside a git repository: ${environment.isGitRepository}`,
		` - Platform: ${environment.platform}`,
		` - Shell: ${environment.shell}`,
		` - OS version: ${environment.osVersion}`,
	].join("\n");
}
