/** US dollars per million tokens, and per web search request. */
export interface ModelRates {
	input: number;
	output: number;
	cacheWrite5m: number;
	/** Absent when the list has no 1h price, so 1h writes pay the 5m price. */
	cacheWrite1h?: number;
	cacheRead: number;
	webSearch: number;
	longPrompt?: LongPromptRates;
}

/** The rates a request pays instead once its whole prompt is longer than `abovePromptTokens`. */
export interface LongPromptRates {
	abovePromptTokens: number;
	input: number;
	output: number;
	cacheWrite5m: number;
	cacheWrite1h: number;
	cacheRead: number;
}

const TIERS = {
	tier_2_10: { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2, webSearch: 0.01 },
	tier_2_10_cache_read_0_10: {
		input: 2,
		output: 10,
		cacheWrite5m: 2.5,
		cacheWrite1h: 4,
		cacheRead: 0.1,
		webSearch: 0.01,
	},
	tier_3_15: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3, webSearch: 0.01 },
	tier_5_25: { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, webSearch: 0.01 },
	tier_15_75: { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5, webSearch: 0.01 },
	tier_10_50: { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1, webSearch: 0.01 },
	tier_10_50_cache_read_0_25: {
		input: 10,
		output: 50,
		cacheWrite5m: 12.5,
		cacheWrite1h: 20,
		cacheRead: 0.25,
		webSearch: 0.01,
	},
	tier_4_20_cache_read_0_20: {
		input: 4,
		output: 20,
		cacheWrite5m: 5,
		cacheWrite1h: 8,
		cacheRead: 0.2,
		webSearch: 0.01,
	},
	haiku_35: { input: 0.8, output: 4, cacheWrite5m: 1, cacheWrite1h: 1.6, cacheRead: 0.08, webSearch: 0.01 },
	haiku_45: { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, webSearch: 0.01 },
	haiku_55: {
		input: 0.1,
		output: 0.5,
		cacheWrite5m: 0.125,
		cacheWrite1h: 0.2,
		cacheRead: 0.01,
		webSearch: 0.01,
		longPrompt: {
			abovePromptTokens: 100000,
			input: 0.5,
			output: 2.5,
			cacheWrite5m: 0.625,
			cacheWrite1h: 1,
			cacheRead: 0.05,
		},
	},
} as const satisfies Record<string, ModelRates>;

type TierName = keyof typeof TIERS;

export interface CatalogModel {
	/** Claude Code's canonical id, which `modelUsage` reports as `canonicalModel`. */
	id: string;
	tier: TierName;
	/** The context window without opting in to anything. */
	window: number;
	/** The output cap Claude Code reports as `maxOutputTokens`. */
	maxOutputTokens: number;
	/** The first-party, Bedrock, Vertex and gateway spellings of the model. */
	providerIds: readonly string[];
}

export const CATALOG: readonly CatalogModel[] = [
	{
		id: "claude-3-5-haiku",
		tier: "haiku_35",
		window: 200000,
		maxOutputTokens: 8192,
		providerIds: [
			"claude-3-5-haiku-20241022",
			"us.anthropic.claude-3-5-haiku-20241022-v1:0",
			"claude-3-5-haiku@20241022",
			"claude-3-5-haiku",
		],
	},
	{
		id: "claude-haiku-4-5",
		tier: "haiku_45",
		window: 200000,
		maxOutputTokens: 32000,
		providerIds: [
			"claude-haiku-4-5-20251001",
			"us.anthropic.claude-haiku-4-5-20251001-v1:0",
			"claude-haiku-4-5@20251001",
			"claude-haiku-4-5",
			"anthropic.claude-haiku-4-5",
		],
	},
	{
		id: "claude-haiku-5-5",
		tier: "haiku_55",
		window: 1000000,
		maxOutputTokens: 128000,
		providerIds: ["claude-haiku-5-5", "us.anthropic.claude-haiku-5-5", "anthropic.claude-haiku-5-5"],
	},
	{
		id: "claude-3-5-sonnet",
		tier: "tier_3_15",
		window: 200000,
		maxOutputTokens: 8192,
		providerIds: [
			"claude-3-5-sonnet-20241022",
			"us.anthropic.claude-3-5-sonnet-20241022-v2:0",
			"claude-3-5-sonnet-v2@20241022",
			"claude-3-5-sonnet",
		],
	},
	{
		id: "claude-3-7-sonnet",
		tier: "tier_3_15",
		window: 200000,
		maxOutputTokens: 32000,
		providerIds: [
			"claude-3-7-sonnet-20250219",
			"us.anthropic.claude-3-7-sonnet-20250219-v1:0",
			"claude-3-7-sonnet@20250219",
			"claude-3-7-sonnet",
		],
	},
	{
		id: "claude-sonnet-4-0",
		tier: "tier_3_15",
		window: 200000,
		maxOutputTokens: 32000,
		providerIds: [
			"claude-sonnet-4-20250514",
			"us.anthropic.claude-sonnet-4-20250514-v1:0",
			"claude-sonnet-4@20250514",
			"claude-sonnet-4",
		],
	},
	{
		id: "claude-sonnet-4-5",
		tier: "tier_3_15",
		window: 200000,
		maxOutputTokens: 32000,
		providerIds: [
			"claude-sonnet-4-5-20250929",
			"us.anthropic.claude-sonnet-4-5-20250929-v1:0",
			"claude-sonnet-4-5@20250929",
			"claude-sonnet-4-5",
		],
	},
	{
		id: "claude-sonnet-4-6",
		tier: "tier_3_15",
		window: 200000,
		maxOutputTokens: 32000,
		providerIds: ["claude-sonnet-4-6", "us.anthropic.claude-sonnet-4-6"],
	},
	{
		id: "claude-sonnet-5",
		tier: "tier_2_10",
		window: 1000000,
		maxOutputTokens: 64000,
		providerIds: ["claude-sonnet-5", "us.anthropic.claude-sonnet-5", "anthropic.claude-sonnet-5"],
	},
	{
		id: "claude-sonnet-5-5",
		tier: "tier_2_10_cache_read_0_10",
		window: 1000000,
		maxOutputTokens: 128000,
		providerIds: ["claude-sonnet-5-5", "us.anthropic.claude-sonnet-5-5", "anthropic.claude-sonnet-5-5"],
	},
	{
		id: "claude-opus-4-0",
		tier: "tier_15_75",
		window: 200000,
		maxOutputTokens: 32000,
		providerIds: [
			"claude-opus-4-20250514",
			"us.anthropic.claude-opus-4-20250514-v1:0",
			"claude-opus-4@20250514",
			"claude-opus-4",
		],
	},
	{
		id: "claude-opus-4-1",
		tier: "tier_15_75",
		window: 200000,
		maxOutputTokens: 32000,
		providerIds: [
			"claude-opus-4-1-20250805",
			"us.anthropic.claude-opus-4-1-20250805-v1:0",
			"claude-opus-4-1@20250805",
			"claude-opus-4-1",
		],
	},
	{
		id: "claude-opus-4-5",
		tier: "tier_5_25",
		window: 200000,
		maxOutputTokens: 32000,
		providerIds: [
			"claude-opus-4-5-20251101",
			"us.anthropic.claude-opus-4-5-20251101-v1:0",
			"claude-opus-4-5@20251101",
			"claude-opus-4-5",
		],
	},
	{
		id: "claude-opus-4-6",
		tier: "tier_5_25",
		window: 200000,
		maxOutputTokens: 64000,
		providerIds: ["claude-opus-4-6", "us.anthropic.claude-opus-4-6-v1"],
	},
	{
		id: "claude-opus-4-7",
		tier: "tier_5_25",
		window: 1000000,
		maxOutputTokens: 64000,
		providerIds: ["claude-opus-4-7", "us.anthropic.claude-opus-4-7", "anthropic.claude-opus-4-7"],
	},
	{
		id: "claude-opus-4-8",
		tier: "tier_5_25",
		window: 1000000,
		maxOutputTokens: 64000,
		providerIds: ["claude-opus-4-8", "us.anthropic.claude-opus-4-8", "anthropic.claude-opus-4-8"],
	},
	{
		id: "claude-opus-5",
		tier: "tier_5_25",
		window: 1000000,
		maxOutputTokens: 64000,
		providerIds: ["claude-opus-5", "us.anthropic.claude-opus-5", "anthropic.claude-opus-5"],
	},
	{
		id: "claude-opus-5-5",
		tier: "tier_4_20_cache_read_0_20",
		window: 1000000,
		maxOutputTokens: 128000,
		providerIds: ["claude-opus-5-5", "us.anthropic.claude-opus-5-5", "anthropic.claude-opus-5-5"],
	},
	{
		id: "claude-fable-5",
		tier: "tier_10_50",
		window: 1000000,
		maxOutputTokens: 64000,
		providerIds: ["claude-fable-5", "us.anthropic.claude-fable-5", "anthropic.claude-fable-5"],
	},
	{
		id: "claude-fable-5-1",
		tier: "tier_10_50_cache_read_0_25",
		window: 1000000,
		maxOutputTokens: 64000,
		providerIds: ["claude-fable-5-1", "us.anthropic.claude-fable-5-1", "anthropic.claude-fable-5-1"],
	},
	{
		id: "claude-mythos-5",
		tier: "tier_10_50",
		window: 1000000,
		maxOutputTokens: 64000,
		providerIds: ["claude-mythos-5"],
	},
	{
		id: "claude-mythos-5-1",
		tier: "tier_10_50_cache_read_0_25",
		window: 1000000,
		maxOutputTokens: 64000,
		providerIds: ["claude-mythos-5-1"],
	},
];

/** What a model Claude Code has no price for pays: the Opus 4.5 to 5 tier. */
export const DEFAULT_RATES: ModelRates = TIERS.tier_5_25;

const FAST_RATES: Readonly<Record<string, ModelRates>> = {
	"claude-opus-5-5": { input: 8, output: 40, cacheWrite5m: 10, cacheWrite1h: 16, cacheRead: 0.4, webSearch: 0.01 },
	"claude-opus-4-8": { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1, webSearch: 0.01 },
	"claude-opus-5": { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1, webSearch: 0.01 },
	"claude-opus-4-6": { input: 30, output: 150, cacheWrite5m: 37.5, cacheWrite1h: 60, cacheRead: 3, webSearch: 0.01 },
	"claude-opus-4-7": { input: 30, output: 150, cacheWrite5m: 37.5, cacheWrite1h: 60, cacheRead: 3, webSearch: 0.01 },
};

const BY_ID = new Map(CATALOG.map((model) => [model.id, model]));
const BY_PROVIDER_ID = new Map(CATALOG.flatMap((model) => model.providerIds.map((id) => [id, model] as const)));
const BY_SPECIFICITY = [...CATALOG].sort((a, b) => b.id.length - a.id.length);
const BARE_GENERATION_4 = /claude-(opus|sonnet)-4(?!-\d(?!\d))/;
const DATE_SUFFIX = /-\d{8}$/;

/** The catalog entry a model name spells, in any provider's form (dated, `[1m]`, Bedrock, Vertex), or undefined for a model Claude Code has no price for. */
export function findCatalogModel(name: string): CatalogModel | undefined {
	const lower = name.toLowerCase().replace(/\[1m\]/g, "");
	const exact = BY_PROVIDER_ID.get(lower);
	if (exact !== undefined) return exact;
	const bare = BARE_GENERATION_4.exec(lower);
	if (bare !== null && !BY_SPECIFICITY.some((model) => lower.includes(model.id))) {
		return BY_ID.get(`claude-${bare[1]}-4-0`);
	}
	const named = BY_SPECIFICITY.find((model) => lower.includes(model.id));
	if (named !== undefined) return named;
	return BY_ID.get(lower.replace(DATE_SUFFIX, ""));
}

/** The per-million-token rates of a catalog model, for a standard or a fast-mode response. */
export function ratesOf(model: CatalogModel, speed: string | undefined): ModelRates {
	if (speed === "fast") return FAST_RATES[model.id] ?? TIERS[model.tier];
	return TIERS[model.tier];
}
