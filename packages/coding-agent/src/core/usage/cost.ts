import type { Usage } from "@earendil-works/pi-ai";
import { CATALOG, type CatalogModel, DEFAULT_RATES, findCatalogModel, type ModelRates, ratesOf } from "./pricing.ts";

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

/** How one model is charged: a rate table, the multiplier a policy sets, and whether the serving region can raise it. */
export interface ModelPrice {
	rates: ModelRates;
	/** The multiplier a managed policy sets. */
	multiplier: number;
	/** Managed per-model rates ignore the serving region. */
	regionPremium: boolean;
	basis: CostBasis;
}

/** The operator's `modelPricing` policy setting. */
export interface PricingPolicy {
	multiplier: number;
	/** Rates per model, keyed by the lower-cased name the policy spells. */
	exact: ReadonlyMap<string, ModelRates>;
	/** The same rates keyed by the catalog id the name resolves to, so any spelling of a built-in model finds them. */
	builtin: ReadonlyMap<string, ModelRates>;
}

/** The operator's `additionalModelCosts` setting: model name → rates, validated rows only. */
export type OperatorCostTable = ReadonlyMap<string, ModelRates>;

/** One `modelCostPromotions` row: price the name `as` a catalog model until `endsAt`. */
export interface AliasPromotion {
	as: string;
	/** Epoch seconds, the unit Claude Code's promotion records carry. */
	endsAt: number;
}

/** The operator's `modelCostPromotions` setting, the pi-native feed for CC's alias promotions. */
export type PromotionTable = ReadonlyMap<string, AliasPromotion>;

/** The operator-fed and session inputs Claude Code's price chain consults beyond its own policy. */
export interface RatesContext {
	/** pi-native operator data source for CC's additionalModelCostsCache (settings/policy key). */
	operatorCosts?: OperatorCostTable;
	/** pi-native operator data source for CC's alder_ford promotion ({as, ends_at}). */
	promotions?: PromotionTable;
	/** The session's selected model (CC's `_d()`); its catalog entry feeds the selected-model fallback. */
	selectedModel?: string;
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
export function costOf(breakdown: UsageBreakdown, price: ModelPrice): number {
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

/**
 * The charge for a model name, through Claude Code's chain: the policy override, an alias promotion,
 * an operator row for an alias's identity spelling, the catalog's fast or list rates, an operator row
 * keyed by the name, the selected model's catalog rates, and finally the default rates.
 * A model that hit none of the catalog, the operator rows and no promotion is marked `unknown`.
 */
export function priceOf(
	name: string,
	speed: string | undefined,
	policy: PricingPolicy | undefined,
	rates: RatesContext | undefined,
): ModelPrice {
	const multiplier = policy?.multiplier ?? 1;
	const identity = name.toLowerCase().replace(/\[1m\]/g, "");
	const model = findCatalogModel(name);

	const configured = policy === undefined ? undefined : managedRates(policy, name, model);
	if (configured !== undefined) {
		return { rates: configured, multiplier, regionPremium: false, basis: "managed" };
	}
	// Fast responses skip the promotion: Claude Code routes them straight at the model's own rates.
	if (speed !== "fast") {
		const promotion = rates?.promotions?.get(identity);
		const target = promotion === undefined ? undefined : findCatalogModel(promotion.as);
		if (promotion !== undefined && target !== undefined && Date.now() < promotion.endsAt * 1000) {
			return { rates: ratesOf(target, speed), multiplier, regionPremium: true, basis: listOrManaged(multiplier) };
		}
	}
	// A name that resolved through an alias can carry an operator row for its exact spelling.
	const operator = rates?.operatorCosts;
	if (operator !== undefined && model !== undefined && model.id !== identity) {
		const aliased = operator.get(identity);
		if (aliased !== undefined) return operatorPrice(aliased, multiplier);
	}
	if (model !== undefined) {
		return { rates: ratesOf(model, speed), multiplier, regionPremium: true, basis: listOrManaged(multiplier) };
	}
	// Only a name outside the catalog reaches here, so the operator row is keyed by its own spelling.
	const named = operator?.get(identity);
	if (named !== undefined) return operatorPrice(named, multiplier);
	const selected = rates?.selectedModel === undefined ? undefined : findCatalogModel(rates.selectedModel);
	if (selected !== undefined) {
		return { rates: ratesOf(selected, speed), multiplier, regionPremium: true, basis: unmatchedBasis(multiplier) };
	}
	return { rates: DEFAULT_RATES, multiplier, regionPremium: true, basis: unmatchedBasis(multiplier) };
}

function listOrManaged(multiplier: number): CostBasis {
	return multiplier === 1 ? "list" : "managed";
}

/** A model nothing matched still reads as managed pricing while a multiplier policy is in force. */
function unmatchedBasis(multiplier: number): CostBasis {
	return multiplier === 1 ? "unknown" : "managed";
}

function operatorPrice(rates: ModelRates, multiplier: number): ModelPrice {
	return { rates, multiplier, regionPremium: false, basis: listOrManaged(multiplier) };
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

/** Reads the `modelPricing` policy value. A bad override row is dropped and an out-of-range multiplier falls back to 1, as Claude Code's reader does. */
export function parsePricingPolicy(value: unknown): PricingPolicy | undefined {
	if (!isRecord(value)) return undefined;
	const multiplier = validMultiplier(value.multiplier) ? value.multiplier : 1;
	const exact = new Map<string, ModelRates>();
	const builtin = new Map<string, ModelRates>();
	const overrides = isRecord(value.overrides) ? value.overrides : {};
	for (const [name, row] of Object.entries(overrides)) {
		const rates = rateRow(row);
		if (rates === undefined) continue;
		const key = rowKey(name);
		if (exact.has(key)) continue;
		exact.set(key, rates);
		const catalogId = exactCatalogModel(key)?.id;
		if (catalogId !== undefined && !builtin.has(catalogId)) builtin.set(catalogId, rates);
	}
	if (exact.size === 0 && multiplier === 1) return undefined;
	return { multiplier, exact, builtin };
}

function validMultiplier(value: unknown): value is number {
	return typeof value === "number" && value > 0 && value <= 10;
}

function exactCatalogModel(key: string): CatalogModel | undefined {
	return CATALOG.find((model) => model.id === key || model.providerIds.includes(key));
}

/** Reads the `additionalModelCosts` setting: model name → rates. A row with a bad shape is dropped. */
export function parseOperatorCosts(value: unknown): OperatorCostTable | undefined {
	return parseRateRows(value);
}

/** Reads the `modelCostPromotions` setting: alias → {as, endsAt}. A row with a bad shape is dropped. */
export function parseCostPromotions(value: unknown): PromotionTable | undefined {
	if (!isRecord(value)) return undefined;
	const promotions = new Map<string, AliasPromotion>();
	for (const [name, row] of Object.entries(value)) {
		if (!isRecord(row) || typeof row.as !== "string" || row.as === "" || !isFiniteNumber(row.endsAt)) continue;
		promotions.set(rowKey(name), { as: row.as, endsAt: row.endsAt });
	}
	return promotions.size > 0 ? promotions : undefined;
}

function rowKey(name: string): string {
	return name.toLowerCase().replace(/\[1m\]/g, "");
}

/** Collects validated cost rows keyed by spelling, dropping every row with a bad shape. */
function parseRateRows(value: unknown): Map<string, ModelRates> | undefined {
	if (!isRecord(value)) return undefined;
	const rows = new Map<string, ModelRates>();
	for (const [name, row] of Object.entries(value)) {
		const rates = rateRow(row);
		if (rates === undefined || rows.has(rowKey(name))) continue;
		rows.set(rowKey(name), rates);
	}
	return rows.size > 0 ? rows : undefined;
}

function rateRow(row: unknown): ModelRates | undefined {
	if (!isRecord(row)) return undefined;
	const { input, output, cacheRead, cacheWrite } = row;
	if (!isRate(input) || !isRate(output) || !isRate(cacheRead) || !isRate(cacheWrite)) return undefined;
	return {
		input,
		output,
		cacheRead,
		cacheWrite5m: cacheWrite,
		...(isRate(row.cacheWrite1h) ? { cacheWrite1h: row.cacheWrite1h } : {}),
		webSearch: isRate(row.webSearch) ? row.webSearch : DEFAULT_RATES.webSearch,
	};
}

function isRate(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface Charge {
	usd: number;
	basis: CostBasis;
}

/** The charge for one finished request of the model named `name`, at the chain's price for it. */
export function chargeFor(
	name: string,
	usage: Usage,
	policy: PricingPolicy | undefined,
	rates: RatesContext | undefined,
): Charge {
	const price = priceOf(name, usage.speed, policy, rates);
	return { usd: costOf(breakdownOf(usage), price), basis: price.basis };
}
