import type { Model } from "@earendil-works/pi-ai";
import type { CompactionResult } from "./compaction.ts";

export const CC_NOT_ENOUGH_MESSAGES = "Not enough messages to compact.";
export const CC_COMPACT_DISABLED = "Compaction is disabled by DISABLE_COMPACT";

/** Consecutive failed speculative summaries after which precomputing stops until a compaction succeeds. */
export const CC_PRECOMPUTE_FAILURE_LIMIT = 3;

export interface CcCompactionPolicy {
	enabled: boolean;
	automaticDisabled: boolean;
	disabled: boolean;
	window?: number;
	byModel: Record<string, number | "auto">;
	windowSource: "model-default" | "session_override" | "environment" | "settings_top_level";
	percent?: number;
	blockingLimit?: number;
	precompute: boolean;
	cold: boolean;
}

export interface CcCompactionLimits {
	window: number;
	effectiveWindow: number;
	threshold: number;
	precompute: number;
	warn: number;
	block: number;
	source: string;
}

export interface CcCompactionHealth {
	failures: number;
	turnsSinceCompact?: number;
	rapidRefills: number;
}

export type CcPrecomputeState =
	| { kind: "idle" }
	| {
			kind: "running";
			leaf: string;
			model: string;
			controller: AbortController;
			promise: Promise<CompactionResult | undefined>;
	  }
	| { kind: "ready"; leaf: string; model: string; result: CompactionResult };

const enabledEnv = (value: string | undefined): boolean => /^(1|true|yes|on)$/i.test(value ?? "");

function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function environmentWindow(value: string | undefined): number | undefined {
	const match = /^\s*(\d+(?:\.\d+)?)([km])?\s*$/i.exec(value ?? "");
	if (!match) return undefined;
	const amount = positive(Number(match[1]));
	if (amount === undefined) return undefined;
	const unit = match[2]?.toLowerCase();
	return Math.min(
		1_000_000,
		Math.max(100_000, Math.round(amount * (unit === "m" ? 1_000_000 : unit === "k" ? 1000 : 1))),
	);
}

/** Resolve operator controls once at the CLI boundary, without changing pi's settings. */
export function ccCompactionPolicy(
	values: Record<string, unknown> = {},
	env: NodeJS.ProcessEnv = process.env,
	sessionWindow?: number,
): CcCompactionPolicy {
	const overrides =
		typeof values.modelSettings === "object" && values.modelSettings !== null ? values.modelSettings : {};
	const byModel: Record<string, number | "auto"> = {};
	for (const [id, value] of Object.entries(overrides)) {
		if (typeof value !== "object" || value === null || !("autoCompactWindow" in value)) continue;
		const window = value.autoCompactWindow === "auto" ? "auto" : positive(value.autoCompactWindow);
		if (window !== undefined) byModel[id] = window;
	}
	const environment = environmentWindow(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
	const setting = positive(values.autoCompactWindow);
	return {
		enabled: values.autoCompactEnabled !== false && !enabledEnv(env.DISABLE_AUTO_COMPACT),
		automaticDisabled: enabledEnv(env.DISABLE_AUTO_COMPACT),
		disabled: enabledEnv(env.DISABLE_COMPACT),
		window: environment ?? sessionWindow ?? setting,
		byModel: sessionWindow !== undefined || environment !== undefined ? {} : byModel,
		windowSource:
			environment !== undefined
				? "environment"
				: sessionWindow !== undefined
					? "session_override"
					: setting !== undefined
						? "settings_top_level"
						: "model-default",
		percent: positive(Number(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)),
		blockingLimit: positive(Number(env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE)),
		precompute: values.precomputeCompactionEnabled === true,
		cold: enabledEnv(env.CLAUDE_CODE_COLD_COMPACT),
	};
}

/** Token limits include output headroom, the compaction buffer, and the blocking buffer. */
export function ccCompactionLimits(
	policy: CcCompactionPolicy,
	model: Pick<Model<string>, "id" | "contextWindow" | "maxTokens">,
): CcCompactionLimits {
	const override = policy.byModel[model.id];
	const window = Math.min(
		model.contextWindow,
		override === "auto" ? model.contextWindow : (override ?? policy.window ?? model.contextWindow),
	);
	const output = Math.min(model.maxTokens, 20_000);
	const effectiveWindow = window - output;
	const threshold =
		policy.percent !== undefined && policy.percent <= 100
			? Math.min(Math.floor((effectiveWindow * policy.percent) / 100), effectiveWindow - 13_000)
			: effectiveWindow - 13_000;
	return {
		window,
		effectiveWindow,
		threshold,
		precompute: Math.min(effectiveWindow - Math.round(effectiveWindow * 0.2), threshold),
		warn: threshold - 20_000,
		block: policy.blockingLimit ?? model.contextWindow - output - 3_000,
		source: override === undefined ? policy.windowSource : "settings_per_model",
	};
}
