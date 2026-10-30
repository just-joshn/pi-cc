/** The Claude Code profile prompt: identity and working text for the system blocks, machine context for the message after the first user turn. */

import type { NormalizedBuildSystemPromptOptions } from "../system-prompt.ts";
import { buildSystemPromptSections } from "../system-prompt.ts";
import type { CcEnvironment } from "./environment.ts";
import {
	CC_BARE_WORKING,
	CC_CONTEXT_GUIDANCE,
	CC_IDENTITY,
	CC_IDENTITY_APPEND_PREFIX,
	CC_WORKING_APPEND_PREFIX,
	CC_WORKING_SECTIONS,
} from "./sections.ts";

export interface CcPromptRecord {
	identity: string;
	working: string;
	context: string;
}

export interface CcPromptMode {
	bare: boolean;
}

/** Sections of pi's own prompt that the Claude Code profile replaces with its own text or drops. */
const PI_ONLY_SECTIONS = new Set(["preamble", "tools", "rules", "docs", "addendum", "cwd"]);

/**
 * Assemble the prompt record. An appended instruction lands in both the identity and the working
 * prompt. A custom prompt replaces the working prompt only. Bare keeps the identity, shortens the
 * working prompt, and leaves the guidance out of the context.
 */
export function assembleCcPrompt(
	options: NormalizedBuildSystemPromptOptions,
	mode: CcPromptMode,
	environment: CcEnvironment,
): CcPromptRecord {
	const appended = options.appendSystemPrompt;
	const base = options.customPrompt ?? (mode.bare ? CC_BARE_WORKING : CC_WORKING_SECTIONS.join("\n\n"));
	return {
		identity: appended ? `${CC_IDENTITY}${CC_IDENTITY_APPEND_PREFIX}${appended}` : CC_IDENTITY,
		working: appended ? `${base}${CC_WORKING_APPEND_PREFIX}${appended}` : base,
		context: renderContext(options, mode, environment),
	};
}

function renderContext(
	options: NormalizedBuildSystemPromptOptions,
	mode: CcPromptMode,
	environment: CcEnvironment,
): string {
	const piSections = buildSystemPromptSections(options);
	const parts = [renderEnvironment(environment)];
	if (piSections.rules) parts.push(piSections.rules);
	if (!mode.bare) parts.push(...CC_CONTEXT_GUIDANCE);
	for (const [name, text] of Object.entries(piSections)) {
		if (!PI_ONLY_SECTIONS.has(name)) parts.push(text);
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
