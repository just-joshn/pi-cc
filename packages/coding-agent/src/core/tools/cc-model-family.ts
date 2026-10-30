/**
 * The model identity Claude Code's legacy prior-read gate tests, one lookup the session's
 * Edit and Write tools share.
 *
 * Claude Code does not compare the raw model id: it first resolves the id to a canonical
 * family name (its `Je` -> `e_`/`uK` chain, dossier `chunk-3xe0k172.js:13665-13745` and the
 * parse helpers in `chunk-j0989z22.js:1-63`), then tests that name against its ten-legacy-model
 * set (`kSn`, `chunk-9wgj206m.js:107-115`). Testing the raw id let dated first-party ids
 * (`claude-haiku-4-5-20251001`), Bedrock ids (`us.anthropic.claude-haiku-4-5-20251001-v1:0`),
 * Vertex ids (`claude-haiku-4-5@20251001`), and mixed-case ids slip past a set of bare names.
 *
 * The `Je` wrapper's settings-override, model-knowledge, and application-inference-profile
 * layers have no pi-cc equivalent and are not ported; on a machine without them `Je` reduces
 * to the canonical-name resolution below. The baked provider-id table (`a7`) is also not
 * copied: every id it maps parses through the same grammar the general path uses, and the
 * general path returns the same canonical name for each of its forms.
 */

/** Claude Code's Bedrock region prefixes (`M7`, `chunk-017gw5jn.js:630`). */
const CC_REGION_PREFIXES = ["us", "eu", "apac", "jp", "au", "us-gov", "global"];

/** Every catalog id Claude Code's resolver can return, in catalog order (`ywe` plus `sw`). */
const CC_CATALOG_IDS = [
	"claude-3-5-haiku",
	"claude-3-5-sonnet",
	"claude-3-7-sonnet",
	"claude-fable-5",
	"claude-fable-5-1",
	"claude-haiku-4-5",
	"claude-haiku-5-5",
	"claude-mythos-5",
	"claude-mythos-5-1",
	"claude-opus-4-0",
	"claude-opus-4-1",
	"claude-opus-4-5",
	"claude-opus-4-6",
	"claude-opus-4-7",
	"claude-opus-4-8",
	"claude-opus-5",
	"claude-opus-5-5",
	"claude-sonnet-4-0",
	"claude-sonnet-4-5",
	"claude-sonnet-4-6",
	"claude-sonnet-5",
	"claude-sonnet-5-5",
	"claude-3-opus",
	"claude-3-sonnet",
	"claude-3-haiku",
];

/**
 * Claude Code's substring fallbacks for ids that do not parse cleanly, in its order. A string
 * entry is an `includes` test; a RegExp entry is Claude Code's `claude-opus-4`/`claude-sonnet-4`
 * patterns that keep bare major versions out of the dated-id buckets.
 */
const CC_NAME_PATTERNS: ReadonlyArray<readonly [string | RegExp, string]> = [
	["claude-fable-5-1", "claude-fable-5-1"],
	["claude-fable-5", "claude-fable-5"],
	["claude-mythos-5-1", "claude-mythos-5-1"],
	["claude-mythos-5", "claude-mythos-5"],
	["claude-opus-5-5", "claude-opus-5-5"],
	["claude-opus-5", "claude-opus-5"],
	["claude-opus-4-8", "claude-opus-4-8"],
	["claude-opus-4-7", "claude-opus-4-7"],
	["claude-opus-4-6", "claude-opus-4-6"],
	["claude-opus-4-5", "claude-opus-4-5"],
	["claude-opus-4-1", "claude-opus-4-1"],
	[/claude-opus-4(?!-\d(?!\d))/, "claude-opus-4-0"],
	["claude-sonnet-5-5", "claude-sonnet-5-5"],
	["claude-sonnet-5", "claude-sonnet-5"],
	["claude-sonnet-4-6", "claude-sonnet-4-6"],
	["claude-sonnet-4-5", "claude-sonnet-4-5"],
	[/claude-sonnet-4(?!-\d(?!\d))/, "claude-sonnet-4-0"],
	["claude-haiku-5-5", "claude-haiku-5-5"],
	["claude-haiku-4-5", "claude-haiku-4-5"],
	["claude-3-7-sonnet", "claude-3-7-sonnet"],
	["claude-3-5-sonnet", "claude-3-5-sonnet"],
	["claude-3-5-haiku", "claude-3-5-haiku"],
	["claude-3-opus", "claude-3-opus"],
	["claude-3-sonnet", "claude-3-sonnet"],
	["claude-3-haiku", "claude-3-haiku"],
];

/** Claude Code's ten legacy model ids whose unread Edit and Write calls are refused (`kSn`'s set). */
const CC_LEGACY_MUTATION_MODELS = new Set([
	"claude-opus-4-6",
	"claude-haiku-4-5",
	"claude-opus-4-5",
	"claude-opus-4-1",
	"claude-opus-4-0",
	"claude-sonnet-4-5",
	"claude-sonnet-4-0",
	"claude-3-7-sonnet",
	"claude-3-5-sonnet",
	"claude-3-5-haiku",
]);

/** One parsed model id: the family, its version, and what followed the version. */
interface CcParsedId {
	family: string;
	major: number;
	minor?: number;
	/** True for the `claude-3-5-sonnet` shape, where the version precedes the family. */
	legacyVersionFirst: boolean;
	/** The matched `claude-<family>-<major>[-<minor>]` prefix. */
	base: string;
	/** An eight-digit date in a recognized suffix form. */
	date?: string;
	/** A suffix the grammar does not recognize, which disqualifies the id from catalog matching. */
	trailer?: string;
}

/** The canonical family name Claude Code resolves `id` to, before gate and capability tests. */
export function claudeModelFamily(id: string): string {
	const e = id.toLowerCase();
	for (const candidate of CC_CATALOG_IDS) {
		if (sameShape(parseId(e), parseId(candidate))) return candidate;
	}
	for (const [pattern, family] of CC_NAME_PATTERNS) {
		if (typeof pattern === "string" ? e.includes(pattern) : pattern.test(e)) return family;
	}
	return e.replace(/-\d{8}$/, "");
}

/** Whether Claude Code refuses unread mutations by this model, before permission checks. */
export function isCcLegacyMutationModel(id: string): boolean {
	return CC_LEGACY_MUTATION_MODELS.has(claudeModelFamily(id.replace(/\[[12]m\]$/i, "")));
}

/** Claude Code's id grammar: `claude-<family>-<major>[-<minor>]` or `claude-<major>[-<minor>]-<family>`. */
function parseClaudeId(n: string): CcParsedId | null {
	const modern = /^claude-([a-z]+)-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?/.exec(n);
	if (modern) {
		const [, family, major, minor] = modern;
		return {
			family,
			major: Number(major),
			minor: minor === undefined ? undefined : Number(minor),
			legacyVersionFirst: false,
			base: modern[0],
		};
	}
	const legacy = /^claude-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?-([a-z]+)/.exec(n);
	if (legacy) {
		const [, major, minor, family] = legacy;
		return {
			family,
			major: Number(major),
			minor: minor === undefined ? undefined : Number(minor),
			legacyVersionFirst: true,
			base: legacy[0],
		};
	}
	return null;
}

/**
 * Claude Code's full id parse: trim, lowercase, strip a `[1m]`/`[2m]` suffix, drop a provider
 * path, accept Bedrock's `<region>.anthropic.<id>` and the dated/`-vN`/`@date` suffix forms.
 */
function parseId(e: string): CcParsedId | null {
	let n = e.trim().toLowerCase();
	if (n === "" || /\s/.test(n)) return null;
	n = n.replace(/\[[12]m\]$/, "");
	const slash = n.lastIndexOf("/");
	if (slash !== -1) n = n.slice(slash + 1);
	const bedrock = /^(?:([a-z-]+)\.)?anthropic\.(claude-.*)$/.exec(n);
	if (bedrock) {
		const region = bedrock[1];
		if (region !== undefined && !CC_REGION_PREFIXES.includes(region)) return null;
		n = bedrock[2] ?? "";
	}
	const parsed = parseClaudeId(n);
	if (!parsed) return null;
	const rest = n.slice(parsed.base.length);
	if (rest !== "" && !/^[-@]/.test(rest)) return null;
	const result: CcParsedId = {
		family: parsed.family,
		major: parsed.major,
		legacyVersionFirst: parsed.legacyVersionFirst,
		base: parsed.base,
	};
	if (parsed.minor !== undefined) result.minor = parsed.minor;
	if (!isCleanSuffix(rest)) {
		result.trailer = rest;
	} else {
		const date = /(?:-v\d+@|[-@])(\d{8})/.exec(rest)?.[1];
		if (date !== undefined) result.date = date;
	}
	return result;
}

/** The suffix forms Claude Code treats as dates or version tags rather than unknown trailers. */
function isCleanSuffix(rest: string): boolean {
	return /^(?:-fast|-latest)?(?:-v\d{1,3}@\d{8}|[-@]\d{8})?(?:-v\d{1,3}(?::\d{1,3})?)?$/.test(rest);
}

/** Whether two parses name the same catalog entry: family, version order, and version. */
function sameShape(left: CcParsedId | null, right: CcParsedId | null): boolean {
	if (left === null || right === null) return false;
	if (left.trailer !== undefined || right.trailer !== undefined) return false;
	return (
		left.family === right.family &&
		left.legacyVersionFirst === right.legacyVersionFirst &&
		left.major === right.major &&
		(left.minor ?? 0) === (right.minor ?? 0)
	);
}
