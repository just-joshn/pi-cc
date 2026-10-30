import type { Usage } from "@earendil-works/pi-ai";
import { type CatalogModel, DEFAULT_RATES, findCatalogModel, type ModelRates, ratesOf } from "./pricing.ts";

/** One request's usage, normalized to the categories Claude Code prices separately. */
export interface UsageBreakdown {
	input: number;
	output: number;
	cacheRead: number;
	/** All cache writes, which is what the long-prompt threshold counts. */
	cacheWrite: number;
	/** The writes at the 1h price, clamped to `cacheWrite`. */
	cacheWrite1h: number;
	/** The 5m figure the response reported, clamped to what the 1h figure leaves. It is zero when the response gave none, though all writes but the 1h ones still pay the 5m price. */
	cacheWrite5m: number;
	webSearchRequests: number;
	inferenceGeo: string | undefined;
	speed: string | undefined;
}

/** `list` is a price Claude Code publishes, `managed` one an operator set in policy, `unknown` a model nobody priced. */
export type CostBasis = "list" | "managed" | "unknown";

/** How one model is charged: from a rate table, or from the cost pi's own catalog already computed. */
export type ModelPrice =
	| {
			kind: "table";
			rates: ModelRates;
			/** The multiplier a managed policy sets. */
			multiplier: number;
			/** Managed per-model rates ignore the serving region. */
			regionPremium: boolean;
			basis: CostBasis;
	  }
	| { kind: "native"; basis: "unknown" };

/** The operator's `modelPricing` policy setting. */
export interface PricingPolicy {
	multiplier: number;
	/** Rates per model, keyed by the lower-cased name the policy spells. */
	exact: ReadonlyMap<string, ModelRates>;
	/** The same rates keyed by the catalog id the name resolves to, so any spelling of a built-in model finds them. */
	builtin: ReadonlyMap<string, ModelRates>;
}

const REGION_PREMIUM = 1.1;

/** Reads the token categories out of a pi usage record. */
export function breakdownOf(usage: Usage): UsageBreakdown {
	const oneHour = clamp(usage.cacheWrite1h ?? 0, usage.cacheWrite);
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		cacheWrite1h: oneHour,
		cacheWrite5m: clamp(usage.cacheWrite5m ?? 0, usage.cacheWrite - oneHour),
		webSearchRequests: usage.webSearchRequests ?? 0,
		inferenceGeo: usage.inferenceGeo,
		speed: usage.speed,
	};
}

function clamp(value: number, max: number): number {
	return Math.min(Math.max(value, 0), max);
}

/** The dollars one request costs at `price`. Every term is a category priced on its own, so the order of terms follows Claude Code's. */
export function costOf(breakdown: UsageBreakdown, price: ModelPrice, nativeUsd: number): number {
	if (price.kind === "native") return nativeUsd;
	const rates = promptRates(price.rates, breakdown);
	const tokens =
		(breakdown.input / 1e6) * rates.input +
		(breakdown.output / 1e6) * rates.output +
		(breakdown.cacheRead / 1e6) * rates.cacheRead +
		cacheWriteCost(rates, breakdown);
	const premium = price.regionPremium && breakdown.inferenceGeo === "us" ? REGION_PREMIUM : 1;
	return (tokens * premium + breakdown.webSearchRequests * rates.webSearch) * price.multiplier;
}

type AppliedRates = Omit<ModelRates, "longPrompt">;

function promptRates(rates: ModelRates, breakdown: UsageBreakdown): AppliedRates {
	const long = rates.longPrompt;
	if (long === undefined) return rates;
	const prompt = breakdown.input + breakdown.cacheRead + breakdown.cacheWrite;
	return prompt > long.abovePromptTokens ? { ...long, webSearch: rates.webSearch } : rates;
}

function cacheWriteCost(rates: AppliedRates, breakdown: UsageBreakdown): number {
	const oneHour = breakdown.cacheWrite1h;
	if (rates.cacheWrite1h === undefined || oneHour <= 0) return (breakdown.cacheWrite / 1e6) * rates.cacheWrite5m;
	return (oneHour / 1e6) * rates.cacheWrite1h + ((breakdown.cacheWrite - oneHour) / 1e6) * rates.cacheWrite5m;
}

/** What the session's pi catalog says about a model Claude Code has no price for. */
export interface NativeCost {
	/** Whether the pi catalog has rates for the model. Zero rates mean it has none. */
	priced: boolean;
}

/**
 * The charge for a model name. A model in Claude Code's catalog pays its list rates, or the operator's.
 * A model outside it that pi's own catalog prices keeps pi's cost. A model nobody prices pays the default
 * rates and is marked `unknown`, as Claude Code does.
 */
export function priceOf(
	name: string,
	speed: string | undefined,
	native: NativeCost,
	policy: PricingPolicy | undefined,
): ModelPrice {
	const model = findCatalogModel(name);
	const configured = policy === undefined ? undefined : managedRates(policy, name, model);
	if (configured !== undefined && policy !== undefined) {
		return {
			kind: "table",
			rates: configured,
			multiplier: policy.multiplier,
			regionPremium: false,
			basis: "managed",
		};
	}
	const multiplier = policy?.multiplier ?? 1;
	if (model !== undefined) {
		const basis = multiplier === 1 ? "list" : "managed";
		return { kind: "table", rates: ratesOf(model, speed), multiplier, regionPremium: true, basis };
	}
	if (native.priced) return { kind: "native", basis: "unknown" };
	return { kind: "table", rates: DEFAULT_RATES, multiplier, regionPremium: true, basis: "unknown" };
}

function managedRates(policy: PricingPolicy, name: string, model: CatalogModel | undefined): ModelRates | undefined {
	const exact = policy.exact.get(name.toLowerCase().replace(/\[1m\]/g, ""));
	if (exact !== undefined) return exact;
	return model === undefined ? undefined : policy.builtin.get(model.id);
}

/** The context window and output cap Claude Code reports for a model it has in its catalog. */
export function catalogLimits(name: string): { contextWindow: number; maxOutputTokens: number } | undefined {
	const model = findCatalogModel(name);
	return model === undefined ? undefined : { contextWindow: model.window, maxOutputTokens: model.maxOutputTokens };
}

/** The name `modelUsage` reports as `canonicalModel`: the catalog id, else the name without a date suffix. */
export function canonicalName(name: string): string {
	return findCatalogModel(name)?.id ?? name.replace(/-\d{8}$/, "");
}

/** Reads the `modelPricing` policy value. A malformed value prices at list, as Claude Code's catch does. */
export function parsePricingPolicy(value: unknown): PricingPolicy | undefined {
	if (!isRecord(value)) return undefined;
	const multiplier = value.multiplier ?? 1;
	if (typeof multiplier !== "number" || !(multiplier > 0)) return undefined;
	const exact = new Map<string, ModelRates>();
	const builtin = new Map<string, ModelRates>();
	const overrides = value.overrides ?? {};
	if (!isRecord(overrides)) return undefined;
	for (const [name, row] of Object.entries(overrides)) {
		const rates = overrideRates(row);
		if (rates === undefined) return undefined;
		const key = name.toLowerCase().replace(/\[1m\]/g, "");
		if (exact.has(key)) continue;
		exact.set(key, rates);
		const catalogId = findCatalogModel(key)?.id;
		if (catalogId !== undefined && !builtin.has(catalogId)) builtin.set(catalogId, rates);
	}
	if (exact.size === 0 && multiplier === 1) return undefined;
	return { multiplier, exact, builtin };
}

function overrideRates(row: unknown): ModelRates | undefined {
	if (!isRecord(row)) return undefined;
	const { input, output, cacheRead, cacheWrite } = row;
	for (const rate of [input, output, cacheRead, cacheWrite]) {
		if (typeof rate !== "number" || !(rate >= 0)) return undefined;
	}
	return {
		input: input as number,
		output: output as number,
		cacheRead: cacheRead as number,
		cacheWrite5m: cacheWrite as number,
		webSearch: DEFAULT_RATES.webSearch,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether pi's own catalog prices a model: a model with no rates at all is one nobody priced. */
export function hasNativeRates(cost: { input: number; output: number } | undefined): boolean {
	return cost !== undefined && (cost.input > 0 || cost.output > 0);
}

export interface Charge {
	usd: number;
	basis: CostBasis;
}

/** The charge for one finished request of the model named `name`, with `nativePriced` saying whether pi's catalog prices it. */
export function chargeFor(
	name: string,
	usage: Usage,
	nativePriced: boolean,
	policy: PricingPolicy | undefined,
): Charge {
	const price = priceOf(name, usage.speed, { priced: nativePriced }, policy);
	return { usd: costOf(breakdownOf(usage), price, usage.cost.total), basis: price.basis };
}
