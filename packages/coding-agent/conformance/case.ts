/** The on-disk conformance case format and its validating loader. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROBES } from "./isolate.ts";

export type NormalizeRule = "paths" | "whitespace" | "version" | "session-id";

export type Turn =
	| { text: string }
	| { tool_use: { name: string; input: unknown } }
	| { tool_uses: { name: string; input: unknown }[] }
	| { sse: unknown[] };

export type StdoutSpec =
	| { kind: "text"; equals?: string; match?: string[]; normalize?: NormalizeRule[] }
	| { kind: "help"; requireFlags?: string[]; requireCommands?: string[]; allowExtra?: boolean }
	| { kind: "json"; records?: string[] }
	| { kind: "jsonl"; minRecords?: number; records?: string[] };

export interface RequestSpec {
	pathStartsWith?: string;
	count?: number;
	bodyEquals?: Record<string, unknown>;
}

export interface CompareSpec {
	exit?: number | number[];
	stdout?: StdoutSpec;
	stderr?: { contains?: string[]; equals?: string };
	files?: string[];
	requests?: RequestSpec[];
}

export type StdinSpec = null | { kind: "text"; data: string } | { kind: "stream-json"; lines: string[] };

export interface ConformanceCase {
	/** `<area>/<case>`, stable forever. */
	id: string;
	area: string;
	/**
	 * Absolute executable to run instead of the side's own CLI. The loader sets it from `probe`; case
	 * data can never name a path.
	 */
	binary?: string;
	argv: string[];
	env: Record<string, string>;
	stdin: StdinSpec;
	/** Seeded into `workspace/`, relative paths. */
	files: Record<string, string>;
	/** Non-null starts the mock model server and points both sides at it. */
	model: { turns: Turn[] } | null;
	timeout_ms: number;
	compare: CompareSpec;
	skip: string[];
}

const SKIP_REASONS = new Set(["macos-only", "needs-tty", "claude-binary-absent", "spec-gap"]);

const DENIED_ARGV_TOKENS = new Set([
	"auth",
	"login",
	"logout",
	"install",
	"uninstall",
	"update",
	"upgrade",
	"setup-token",
	"purge",
	"respawn",
	"plugin",
	"plugins",
	"migrate-installer",
	"import",
	"gateway",
	"ultrareview",
	"rm",
	"bg",
]);

const CASE_KEYS = ["id", "area", "probe", "argv", "env", "stdin", "files", "model", "timeout_ms", "compare", "skip"];
const COMPARE_KEYS = ["exit", "stdout", "stderr", "files", "requests"];
const TEXT_STDOUT_KEYS = ["kind", "equals", "match", "normalize"];
const HELP_STDOUT_KEYS = ["kind", "requireFlags", "requireCommands", "allowExtra"];
const JSON_STDOUT_KEYS = ["kind", "records"];
const JSONL_STDOUT_KEYS = ["kind", "minRecords", "records"];
const STDERR_KEYS = ["contains", "equals"];
const REQUEST_KEYS = ["pathStartsWith", "count", "bodyEquals"];
const MODEL_KEYS = ["turns"];
const TURN_KEYS = ["text", "tool_use", "tool_uses", "sse"] as const;
const TOOL_USE_KEYS = ["name", "input"];

export function loadCases(casesDir: string): ConformanceCase[] {
	if (!existsSync(casesDir)) throw new Error(`No cases directory at ${casesDir}`);
	const cases: ConformanceCase[] = [];
	for (const area of readdirSync(casesDir, { withFileTypes: true })) {
		if (!area.isDirectory()) continue;
		const areaDir = join(casesDir, area.name);
		for (const entry of readdirSync(areaDir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const path = join(areaDir, entry.name);
			const source = `${area.name}/${entry.name}`;
			cases.push(parseCase(JSON.parse(readFileSync(path, "utf8")), source, area.name));
		}
	}
	return cases.sort((left, right) => left.id.localeCompare(right.id));
}

function parseCase(raw: unknown, source: string, area: string): ConformanceCase {
	const object = asCheckedObject(raw, source, "case", CASE_KEYS);
	const id = asString(object.id, source, "id");
	if (!id.startsWith(`${area}/`)) fail(source, `id "${id}" does not start with the area "${area}/"`);
	if (asString(object.area, source, "area") !== area) fail(source, `area must be "${area}"`);
	const skip = asOptionalStringArray(object.skip, source, "skip") ?? [];
	for (const reason of skip) {
		if (!SKIP_REASONS.has(reason)) fail(source, `unknown skip reason "${reason}"`);
	}
	const model = object.model === null ? null : asCheckedObject(object.model, source, "model", MODEL_KEYS);
	const argv = asOptionalStringArray(object.argv, source, "argv") ?? [];
	assertArgvAllowed(argv, source);
	return {
		id,
		area,
		binary: asProbePath(object.probe, source),
		argv,
		env: asStringRecord(object.env, source, "env"),
		stdin: asStdin(object.stdin, source),
		files: asStringRecord(object.files, source, "files"),
		model: model === null ? null : { turns: asTurns(model.turns, source) },
		timeout_ms: asOptionalNumber(object.timeout_ms, source, "timeout_ms") ?? 60_000,
		compare: asCompareSpec(object.compare, source),
		skip,
	};
}

/**
 * The second line, not the boundary: the Seatbelt profile in `isolate.ts` is what bounds a case. A case
 * still must never reach a subcommand that authenticates, installs, or mutates the installed claude, so
 * every token is checked, not just the first, lowercased with leading dashes stripped, so `--login` and
 * `LOGIN` are refused too.
 */
function assertArgvAllowed(argv: readonly string[], source: string): void {
	for (const token of argv) {
		if (token.startsWith("--update")) {
			fail(source, `argv must not contain "${token}": the harness never updates the installed claude`);
		}
		const name = token.replace(/^-+/, "").toLowerCase();
		if (DENIED_ARGV_TOKENS.has(name)) {
			fail(
				source,
				`argv must not run "${token}": the harness never runs a claude subcommand that authenticates, installs, or mutates`,
			);
		}
	}
}

/** Resolves the case's probe name into the program it runs. Case data names a probe, never a path. */
function asProbePath(value: unknown, source: string): string | undefined {
	const probe = asOptionalString(value, source, "probe");
	if (probe === undefined) return undefined;
	const path = Object.entries(PROBES).find(([name]) => name === probe)?.[1];
	if (path === undefined) fail(source, `unknown probe "${probe}"`);
	return path;
}

function asCompareSpec(value: unknown, source: string): CompareSpec {
	const object = asCheckedObject(value, source, "compare", COMPARE_KEYS);
	const exit = object.exit;
	if (exit !== undefined && typeof exit !== "number" && !isNumberArray(exit)) {
		fail(source, "compare.exit must be a number or an array of numbers");
	}
	return {
		exit: exit as number | number[] | undefined,
		stdout: asStdoutSpec(object.stdout, source),
		stderr: asStderrSpec(object.stderr, source),
		files: asOptionalStringArray(object.files, source, "compare.files"),
		requests: asOptionalRequestSpecs(object.requests, source),
	};
}

function asStdoutSpec(value: unknown, source: string): StdoutSpec | undefined {
	if (value === undefined) return undefined;
	const object = asObject(value, source, "compare.stdout");
	const kind = asString(object.kind, source, "compare.stdout.kind");
	if (kind === "text") {
		assertKnownKeys(object, TEXT_STDOUT_KEYS, source, "compare.stdout");
		return {
			kind,
			equals: asOptionalString(object.equals, source, "compare.stdout.equals"),
			match: asOptionalStringArray(object.match, source, "compare.stdout.match"),
			normalize: asOptionalNormalizeRules(object.normalize, source),
		};
	}
	if (kind === "help") {
		assertKnownKeys(object, HELP_STDOUT_KEYS, source, "compare.stdout");
		return {
			kind,
			requireFlags: asOptionalStringArray(object.requireFlags, source, "compare.stdout.requireFlags"),
			requireCommands: asOptionalStringArray(object.requireCommands, source, "compare.stdout.requireCommands"),
			allowExtra: asOptionalBoolean(object.allowExtra, source, "compare.stdout.allowExtra"),
		};
	}
	if (kind === "json") {
		assertKnownKeys(object, JSON_STDOUT_KEYS, source, "compare.stdout");
		return { kind, records: asOptionalStringArray(object.records, source, "compare.stdout.records") };
	}
	if (kind === "jsonl") {
		assertKnownKeys(object, JSONL_STDOUT_KEYS, source, "compare.stdout");
		return {
			kind,
			minRecords: asOptionalPositiveInteger(object.minRecords, source, "compare.stdout.minRecords"),
			records: asOptionalStringArray(object.records, source, "compare.stdout.records"),
		};
	}
	return fail(source, `unknown compare.stdout.kind "${kind}"`);
}

function asStderrSpec(value: unknown, source: string) {
	if (value === undefined) return undefined;
	const object = asCheckedObject(value, source, "compare.stderr", STDERR_KEYS);
	return {
		contains: asOptionalStringArray(object.contains, source, "compare.stderr.contains"),
		equals: asOptionalString(object.equals, source, "compare.stderr.equals"),
	};
}

function asOptionalRequestSpecs(value: unknown, source: string): RequestSpec[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) fail(source, "compare.requests must be an array");
	return value.map((entry, index) => {
		const field = `compare.requests[${index}]`;
		const object = asCheckedObject(entry, source, field, REQUEST_KEYS);
		const body = object.bodyEquals;
		if (body !== undefined) asObject(body, source, `${field}.bodyEquals`);
		return {
			pathStartsWith: asOptionalString(object.pathStartsWith, source, "pathStartsWith"),
			count: asOptionalNumber(object.count, source, "count"),
			bodyEquals: body as Record<string, unknown> | undefined,
		};
	});
}

function asTurns(value: unknown, source: string): Turn[] {
	if (!Array.isArray(value)) fail(source, "model.turns must be an array");
	return value.map((entry, index) => {
		const field = `model.turns[${index}]`;
		const object = asCheckedObject(entry, source, field, TURN_KEYS);
		const kinds = TURN_KEYS.filter((key) => object[key] !== undefined);
		if (kinds.length !== 1) {
			const found = kinds.length === 0 ? "none" : kinds.join(", ");
			fail(source, `${field} must set exactly one of ${TURN_KEYS.join(", ")}, found ${found}`);
		}
		const kind = kinds[0];
		if (kind === "text") return { text: asString(object.text, source, `${field}.text`) };
		if (kind === "sse") {
			if (!Array.isArray(object.sse)) fail(source, `${field}.sse must be an array`);
			return { sse: object.sse };
		}
		if (kind === "tool_use") return { tool_use: asToolUse(object.tool_use, source, `${field}.tool_use`) };
		if (!Array.isArray(object.tool_uses)) fail(source, `${field}.tool_uses must be an array`);
		return { tool_uses: object.tool_uses.map((toolUse) => asToolUse(toolUse, source, `${field}.tool_uses[]`)) };
	});
}

function asToolUse(value: unknown, source: string, field: string) {
	const object = asCheckedObject(value, source, field, TOOL_USE_KEYS);
	return { name: asString(object.name, source, `${field}.name`), input: object.input };
}

function asStdin(value: unknown, source: string): StdinSpec {
	if (value === undefined || value === null) return null;
	const object = asObject(value, source, "stdin");
	const kind = asString(object.kind, source, "stdin.kind");
	if (kind === "text") {
		assertKnownKeys(object, ["kind", "data"], source, "stdin");
		return { kind, data: asString(object.data, source, "stdin.data") };
	}
	if (kind === "stream-json") {
		assertKnownKeys(object, ["kind", "lines"], source, "stdin");
		return { kind, lines: asOptionalStringArray(object.lines, source, "stdin.lines") ?? [] };
	}
	return fail(source, `unknown stdin.kind "${kind}"`);
}

function asOptionalNormalizeRules(value: unknown, source: string): NormalizeRule[] | undefined {
	const rules = asOptionalStringArray(value, source, "compare.stdout.normalize");
	if (rules === undefined) return undefined;
	const known = new Set<NormalizeRule>(["paths", "whitespace", "version", "session-id"]);
	for (const rule of rules) {
		if (!known.has(rule as NormalizeRule)) fail(source, `unknown normalize rule "${rule}"`);
	}
	return rules as NormalizeRule[];
}

function asStringRecord(value: unknown, source: string, field: string): Record<string, string> {
	if (value === undefined) return {};
	const object = asObject(value, source, field);
	const record: Record<string, string> = {};
	for (const [key, entry] of Object.entries(object)) record[key] = asString(entry, source, `${field}.${key}`);
	return record;
}

function asString(value: unknown, source: string, field: string): string {
	if (typeof value !== "string") fail(source, `${field} must be a string`);
	return value;
}

function asOptionalString(value: unknown, source: string, field: string): string | undefined {
	if (value === undefined) return undefined;
	return asString(value, source, field);
}

function asOptionalNumber(value: unknown, source: string, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) fail(source, `${field} must be a number`);
	return value;
}

function asOptionalPositiveInteger(value: unknown, source: string, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		fail(source, `${field} must be a positive integer`);
	}
	return value;
}

function asOptionalBoolean(value: unknown, source: string, field: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") fail(source, `${field} must be a boolean`);
	return value;
}

function asOptionalStringArray(value: unknown, source: string, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		fail(source, `${field} must be an array of strings`);
	}
	return value;
}

function isNumberArray(value: unknown): boolean {
	return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}

function asObject(value: unknown, source: string, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail(source, `${field} must be an object`);
	return value as Record<string, unknown>;
}

/** An object the loader reads by name, so a misspelled key cannot silently drop a rule. */
function asCheckedObject(
	value: unknown,
	source: string,
	field: string,
	allowed: readonly string[],
): Record<string, unknown> {
	const object = asObject(value, source, field);
	assertKnownKeys(object, allowed, source, field);
	return object;
}

function assertKnownKeys(
	object: Record<string, unknown>,
	allowed: readonly string[],
	source: string,
	field: string,
): void {
	const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) fail(source, `${field} has unknown key "${unknown[0]}"`);
}

function fail(source: string, message: string): never {
	throw new Error(`${source}: ${message}`);
}
