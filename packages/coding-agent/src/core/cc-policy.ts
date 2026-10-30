/** Every Claude Code versus pi decision for a run: effort, token cap, betas, fallback chain, autocompact, prompt snapshot. */

import { createHash } from "node:crypto";
import type { Api, CcWireProfile, Model } from "@earendil-works/pi-ai";
import type { CcFlags } from "../cli/cc-flags.ts";

export type CcEffort = NonNullable<CcWireProfile["effort"]>;

export type CcEntrypoint = "sdk-cli" | "cli";

/** The Claude Code build the wire shape follows. */
export const CC_PARITY_VERSION = "2.1.312";

/** `max_tokens` Claude Code sends for a model id its catalog does not carry. */
export const CC_UNKNOWN_MODEL_MAX_TOKENS = 32_000;

/** Output caps Claude Code sends where they differ from the pi catalog, keyed like the effort table. */
const MAX_TOKENS: Readonly<Record<string, number>> = {
	"claude-opus-5-5": 128_000,
	"claude-fable-5-1": 64_000,
	"claude-haiku-4-5": 32_000,
};

export const CC_AUTOCOMPACT_MIN_TOKENS = 100_000;
export const CC_AUTOCOMPACT_MAX_TOKENS = 1_000_000;

const EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/** Per-model default effort of the pinned Claude Code catalog, keyed by id with any date suffix removed. */
const DEFAULT_EFFORT: Readonly<Record<string, CcEffort>> = {
	"claude-opus-5-5": "medium",
	"claude-sonnet-5-5": "medium",
	"claude-haiku-5-5": "medium",
	"claude-opus-4-8": "high",
	"claude-opus-5": "high",
	"claude-sonnet-5": "high",
	"claude-fable-5": "high",
	"claude-fable-5-1": "high",
	"claude-opus-4-7": "xhigh",
};

/** The betas the pinned Claude Code sends on every request. */
export const CC_AUTO_BETAS: readonly string[] = [
	"claude-code-20250219",
	"interleaved-thinking-2025-05-14",
	"context-management-2025-06-27",
	"per-turn-control-2026-07-01",
	"mid-conversation-tool-changes-2026-07-01",
	"thinking-token-count-2026-05-13",
	"advanced-tool-use-2025-11-20",
	"effort-2025-11-24",
];

/** Effort used for a model with effort control that the table does not list. */
const FALLBACK_EFFORT: CcEffort = "high";

export interface CcPolicy {
	entrypoint: CcEntrypoint;
	/** `--effort`, already validated by the flag table. */
	effort?: CcEffort;
	extraBetas: readonly string[];
	/** `--fallback-model` names in the order they are tried. */
	fallbackModels: readonly string[];
	/** Compaction window from `--autocompact <tokens>`; absent for `auto`. */
	autocompactWindow?: number;
	/** The per-machine context goes to the first user message. Never set when `--system-prompt` replaced the default prompt. */
	excludeDynamic: boolean;
	/** The prompt is recorded once and replayed. Off renders it fresh for every request. */
	snapshot: boolean;
	bare: boolean;
	/** `--system-prompt` replaced the default working prompt. */
	customPrompt: boolean;
}

export interface CcPolicyInput {
	flags: Pick<
		CcFlags,
		| "effort"
		| "betas"
		| "fallbackModel"
		| "autocompact"
		| "excludeDynamicSystemPromptSections"
		| "systemPromptSnapshot"
		| "bare"
	>;
	entrypoint: CcEntrypoint;
	customPrompt: boolean;
}

/** The policy of a run from its flags. */
export function buildCcPolicy(input: CcPolicyInput): CcPolicy {
	const { flags } = input;
	const bare = flags.bare === true;
	const snapshotFlag = flags.systemPromptSnapshot;
	return {
		entrypoint: input.entrypoint,
		effort: parseEffort(flags.effort),
		extraBetas: flags.betas ?? [],
		fallbackModels: parseFallbackModels(flags.fallbackModel),
		autocompactWindow: parseAutocompact(flags.autocompact),
		excludeDynamic: flags.excludeDynamicSystemPromptSections === true && !input.customPrompt,
		snapshot: snapshotFlag === undefined ? !bare : snapshotFlag === "on",
		bare,
		customPrompt: input.customPrompt,
	};
}

function parseEffort(value: string | undefined): CcEffort | undefined {
	return value !== undefined && EFFORT_LEVELS.includes(value) ? (value as CcEffort) : undefined;
}

/** The names of a comma-separated `--fallback-model` list, trimmed, empty entries dropped. */
export function parseFallbackModels(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
}

/** The window `--autocompact` names: a token count in range, or undefined for `auto` and any other value. */
export function parseAutocompact(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value)) return undefined;
	const tokens = Number(value);
	return tokens >= CC_AUTOCOMPACT_MIN_TOKENS && tokens <= CC_AUTOCOMPACT_MAX_TOKENS ? tokens : undefined;
}

/** The id with a trailing date and any provider prefix removed, the key of the effort table. */
function catalogKey(modelId: string): string {
	return modelId
		.toLowerCase()
		.replace(/^anthropic\//, "")
		.replace(/-\d{8}$/, "");
}

/** Whether the model takes an effort level on the Anthropic wire. */
export function supportsEffort(model: Model<"anthropic-messages">): boolean {
	return model.compat?.supportsMidConvoEffort === true || model.compat?.forceAdaptiveThinking === true;
}

/**
 * The effort a request sends: `--effort`, else the catalog default of the model, else "high". A model
 * without effort control sends none, and neither does an id outside the catalog on a model that has
 * none, because an id outside the catalog is treated as one that has it.
 */
export function resolveEffort(
	flag: CcEffort | undefined,
	model: Model<"anthropic-messages">,
	known: boolean,
): CcEffort | undefined {
	if (known && !supportsEffort(model)) return undefined;
	return flag ?? DEFAULT_EFFORT[catalogKey(model.id)] ?? FALLBACK_EFFORT;
}

/** The first `system` block: the build and entrypoint, with a short fingerprint of both. */
export function billingHeader(entrypoint: CcEntrypoint): string {
	const fingerprint = createHash("sha256").update(`${CC_PARITY_VERSION}:${entrypoint}`).digest("hex").slice(0, 3);
	return `x-anthropic-billing-header: cc_version=${CC_PARITY_VERSION}.${fingerprint}; cc_entrypoint=${entrypoint};`;
}

/**
 * The wire profile of one request, or undefined when the model is not on the Anthropic transport.
 * `known` is whether the model catalog carries the id.
 */
export function ccWireProfile(
	policy: CcPolicy,
	model: Model<Api>,
	known: boolean,
	/** `CLAUDE_CODE_MAX_OUTPUT_TOKENS` already set the model's cap, which then stands. */
	capOverridden: boolean,
): CcWireProfile | undefined {
	if (model.api !== "anthropic-messages") return undefined;
	return {
		maxTokens: capOverridden ? undefined : ccMaxTokens(model, known),
		billingHeader: billingHeader(policy.entrypoint),
		effort: resolveEffort(policy.effort, model as Model<"anthropic-messages">, known),
		extraBetas: [...CC_AUTO_BETAS, ...policy.extraBetas],
	};
}

/** The `max_tokens` Claude Code sends: its own cap for a listed model, 32000 for an unknown id, else the catalog's. */
function ccMaxTokens(model: Model<Api>, known: boolean): number | undefined {
	if (!known) return Math.min(model.maxTokens, CC_UNKNOWN_MODEL_MAX_TOKENS);
	return MAX_TOKENS[catalogKey(model.id)];
}

/** The compaction window of a model under the policy. */
export function compactionWindow(policy: CcPolicy | undefined, modelContextWindow: number): number {
	return policy?.autocompactWindow === undefined
		? modelContextWindow
		: Math.min(modelContextWindow, policy.autocompactWindow);
}
