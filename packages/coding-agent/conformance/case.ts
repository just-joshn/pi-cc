/** The on-disk conformance case format and its validating loader. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type NormalizeRule = "paths" | "whitespace" | "version" | "session-id";

export type Turn =
	| { text: string }
	| { tool_use: { name: string; input: unknown } }
	| { tool_uses: { name: string; input: unknown }[] }
	| { sse: unknown[] };

export type StdoutSpec =
	| { kind: "text"; equals?: string; match?: string[]; normalize?: NormalizeRule[] }
	| { kind: "help"; requireFlags?: string[]; requireCommands?: string[]; allowExtra?: boolean }
	| { kind: "json"; records?: string[] };

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
	/** Absolute executable to run instead of the side's own CLI. Isolation cases use this. */
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
	const object = asObject(raw, source, "case");
	const id = asString(object.id, source, "id");
	if (!id.startsWith(`${area}/`)) fail(source, `id "${id}" does not start with the area "${area}/"`);
	if (asString(object.area, source, "area") !== area) fail(source, `area must be "${area}"`);
	const skip = asOptionalStringArray(object.skip, source, "skip") ?? [];
	for (const reason of skip) {
		if (!SKIP_REASONS.has(reason)) fail(source, `unknown skip reason "${reason}"`);
	}
	const model = object.model === null ? null : asObject(object.model, source, "model");
	return {
		id,
		area,
		binary: asOptionalString(object.binary, source, "binary"),
		argv: asOptionalStringArray(object.argv, source, "argv") ?? [],
		env: asStringRecord(object.env, source, "env"),
		stdin: asStdin(object.stdin, source),
		files: asStringRecord(object.files, source, "files"),
		model: model === null ? null : { turns: asTurns(model.turns, source) },
		timeout_ms: asOptionalNumber(object.timeout_ms, source, "timeout_ms") ?? 60_000,
		compare: asCompareSpec(object.compare, source),
		skip,
	};
}

function asCompareSpec(value: unknown, source: string): CompareSpec {
	const object = asObject(value, source, "compare");
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
		return {
			kind,
			equals: asOptionalString(object.equals, source, "compare.stdout.equals"),
			match: asOptionalStringArray(object.match, source, "compare.stdout.match"),
			normalize: asOptionalNormalizeRules(object.normalize, source),
		};
	}
	if (kind === "help") {
		return {
			kind,
			requireFlags: asOptionalStringArray(object.requireFlags, source, "compare.stdout.requireFlags"),
			requireCommands: asOptionalStringArray(object.requireCommands, source, "compare.stdout.requireCommands"),
			allowExtra: object.allowExtra === true,
		};
	}
	if (kind === "json") {
		return { kind, records: asOptionalStringArray(object.records, source, "compare.stdout.records") };
	}
	return fail(source, `unknown compare.stdout.kind "${kind}"`);
}

function asStderrSpec(value: unknown, source: string) {
	if (value === undefined) return undefined;
	const object = asObject(value, source, "compare.stderr");
	return {
		contains: asOptionalStringArray(object.contains, source, "compare.stderr.contains"),
		equals: asOptionalString(object.equals, source, "compare.stderr.equals"),
	};
}

function asOptionalRequestSpecs(value: unknown, source: string): RequestSpec[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) fail(source, "compare.requests must be an array");
	return value.map((entry, index) => {
		const object = asObject(entry, source, `compare.requests[${index}]`);
		const body = object.bodyEquals;
		if (body !== undefined) asObject(body, source, `compare.requests[${index}].bodyEquals`);
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
		const object = asObject(entry, source, `model.turns[${index}]`);
		if (typeof object.text === "string") return { text: object.text };
		if (object.tool_use !== undefined) {
			const toolUse = asObject(object.tool_use, source, "model.turns[].tool_use");
			return { tool_use: { name: asString(toolUse.name, source, "tool_use.name"), input: toolUse.input } };
		}
		if (Array.isArray(object.tool_uses)) {
			return { tool_uses: object.tool_uses.map((toolUse) => asToolUse(toolUse, source)) };
		}
		if (Array.isArray(object.sse)) return { sse: object.sse };
		return fail(source, `model.turns[${index}] is not a text, tool_use, tool_uses or sse turn`);
	});
}

function asToolUse(value: unknown, source: string) {
	const object = asObject(value, source, "tool_uses[]");
	return { name: asString(object.name, source, "tool_uses[].name"), input: object.input };
}

function asStdin(value: unknown, source: string): StdinSpec {
	if (value === undefined || value === null) return null;
	const object = asObject(value, source, "stdin");
	const kind = asString(object.kind, source, "stdin.kind");
	if (kind === "text") return { kind, data: asString(object.data, source, "stdin.data") };
	if (kind === "stream-json") return { kind, lines: asOptionalStringArray(object.lines, source, "stdin.lines") ?? [] };
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

function fail(source: string, message: string): never {
	throw new Error(`${source}: ${message}`);
}
