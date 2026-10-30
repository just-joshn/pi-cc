/** The on-disk conformance case format and its validating loader. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { argvProblem, envProblem, unsetProblem } from "./allowlist.ts";
import { toRegExp } from "./compare.ts";
import {
	HARNESS_FAILURE_KINDS,
	PLANTABLE_VIOLATION_KINDS,
	type PlantableViolationKind,
	PROBES,
	type ProbeName,
	type SideName,
} from "./isolate.ts";
import type { Shape } from "./shape.ts";

export type NormalizeRule = "paths" | "whitespace" | "version" | "session-id";

type TurnBody =
	| { text: string }
	| { tool_use: { name: string; input: unknown } }
	| { tool_uses: { name: string; input: unknown }[] }
	| { sse: unknown[] }
	| { error: { status: number; body: unknown } };

/** `hold_ms` stalls a streamed turn: the mock pauses after the third event it writes, so a case can act mid-stream. */
export type Turn = TurnBody & { hold_ms?: number };

export type StdoutSpec =
	| { kind: "text"; equals?: string; match?: string[]; normalize?: NormalizeRule[] }
	| { kind: "help"; requireFlags?: string[]; requireCommands?: string[]; allowExtra?: boolean }
	| { kind: "json"; records?: string[]; shape?: Shape }
	| { kind: "jsonl"; minRecords?: number; records?: string[] }
	| { kind: "frames"; frames: Shape[] };

export interface RequestSpec {
	pathStartsWith?: string;
	count?: number;
	method?: string;
	/** A `null` value asserts the header is absent. */
	headers?: Record<string, HeaderValueSpec>;
	bodyEquals?: Record<string, unknown>;
	/** Text every one of which must appear in the serialized body of some matched request. */
	bodyIncludes?: string[];
	/** Text that must appear in no matched request's serialized body. */
	bodyExcludes?: string[];
	/** Patterns the serialized body of the last matched request must match, for text a subset cannot pin. */
	bodyMatch?: string[];
	/** Patterns the serialized body of the last matched request must not match. */
	bodyNotMatch?: string[];
	/**
	 * Patterns keyed by a dotted body path such as `messages.0.content.0.text` (a negative index counts
	 * from the end), checked on one matched request, so a case can pin where text lands, not only that
	 * it was sent. A string value is tested as is, anything else as its JSON.
	 */
	bodyAt?: Record<string, BodyTextSpec>;
	/**
	 * Lengths keyed by the same dotted body paths, checked on the same request as `bodyAt`. The text at
	 * the path must be within `tolerance` (default 15 percent) of `around`, so a case pins the size of a
	 * prompt block, which two clean-room texts can only match in length.
	 */
	bodyLength?: Record<string, BodyLengthSpec>;
	/** Dotted body paths whose value must be identical on every matched request, so a case can pin a replayed prompt. */
	bodySame?: string[];
	/** Which matched request `bodyAt` reads. Negative counts from the end; the default is the last. */
	index?: number;
}

export interface BodyLengthSpec {
	around: number;
	tolerance?: number;
}

export interface BodyTextSpec {
	match?: string[];
	notMatch?: string[];
}

/**
 * A header the case asserts. A string is the whole value, `null` is absence, and an object is for a value
 * whose exact text is not the point: a comma-joined feature list, or a credential the harness supplied.
 */
export type HeaderValueSpec = string | null | { present?: boolean; contains?: string[]; excludes?: string[] };

export interface CompareSpec {
	exit?: number | number[];
	stdout?: StdoutSpec;
	stderr?: { contains?: string[]; equals?: string };
	files?: FileSpec[];
	/** Absolute paths, expanded like argv, that must not exist after the run. */
	absent?: string[];
	/**
	 * Violations the case planted and the harness must report. A violation the harness reports and the
	 * case does not name fails the case, so an isolation case can prove the harness caught an escape
	 * attempt instead of trusting that it would.
	 */
	containment?: ContainmentSpec[];
	requests?: RequestSpec[];
}

/** One escape attempt a case plants: what the harness must report, and where it was planted. */
export interface ContainmentSpec {
	kind: PlantableViolationKind;
	/** Workspace-relative. Omitted when the violation is the workspace itself, as in a swapped anchor. */
	path?: string;
}

/** A workspace file the run must write, and optionally a fragment its text must contain. */
export type FileSpec = string | { path: string; contains?: string[] };

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
	/** Harness-provided keys this case removes to observe the side with nothing seeded. */
	unset: string[];
	stdin: StdinSpec;
	/**
	 * Seeded into `workspace/`, relative paths. Content expands like argv, so a seeded settings hook can
	 * name `$REAL_HOME` and prove it cannot write there.
	 */
	files: Record<string, string>;
	/** Workspace-relative directory the side starts in, so a case can observe a walk above its cwd. */
	cwd: string | undefined;
	/** Non-null starts the mock model server and points both sides at it. */
	model: { turns: Turn[] } | null;
	timeout_ms: number;
	compare: CompareSpec;
	skip: string[];
	/**
	 * Sides this case cannot run, with the reason. A side named here is reported as not applicable and
	 * never as a pass, so a case that only one side can execute says so out loud.
	 */
	notApplicable: Partial<Record<SideName, string>>;
}

const SKIP_REASONS = new Set(["macos-only", "needs-tty", "claude-binary-absent", "spec-gap"]);

const CASE_KEYS = [
	"id",
	"area",
	"probe",
	"argv",
	"env",
	"unset",
	"stdin",
	"files",
	"cwd",
	"model",
	"timeout_ms",
	"compare",
	"skip",
	"not_applicable",
];
const COMPARE_KEYS = ["exit", "stdout", "stderr", "files", "absent", "containment", "requests"];
const FILE_SPEC_KEYS = ["path", "contains"];
const CONTAINMENT_KEYS = ["kind", "path"];
const SIDE_NAMES: readonly SideName[] = ["claude", "pi-cc"];
const TEXT_STDOUT_KEYS = ["kind", "equals", "match", "normalize"];
const HELP_STDOUT_KEYS = ["kind", "requireFlags", "requireCommands", "allowExtra"];
const JSON_STDOUT_KEYS = ["kind", "records", "shape"];
const FRAMES_STDOUT_KEYS = ["kind", "frames"];
const JSONL_STDOUT_KEYS = ["kind", "minRecords", "records"];
const STDERR_KEYS = ["contains", "equals"];
const REQUEST_KEYS = [
	"pathStartsWith",
	"count",
	"method",
	"headers",
	"bodyEquals",
	"bodyIncludes",
	"bodyExcludes",
	"bodyMatch",
	"bodyNotMatch",
	"bodyAt",
	"bodyLength",
	"bodySame",
	"index",
];
const BODY_TEXT_KEYS = ["match", "notMatch"];
const BODY_LENGTH_KEYS = ["around", "tolerance"];
const MODEL_KEYS = ["turns"];
/** Node's setTimeout takes a signed 32-bit millisecond count and clamps anything larger to 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const TURN_KEYS = ["text", "tool_use", "tool_uses", "sse", "error"] as const;
const TURN_FIELDS = [...TURN_KEYS, "hold_ms"];
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
	const probe = asProbeName(object.probe, source);
	const argv = asOptionalStringArray(object.argv, source, "argv") ?? [];
	const notApplicable = asNotApplicable(object.not_applicable, source);
	const problem = argvProblem(argv, probe ?? "side", notApplicable.claude === undefined);
	if (problem !== undefined) fail(source, problem);
	const env = asStringRecord(object.env, source, "env");
	const envIssue = envProblem(env);
	if (envIssue !== undefined) fail(source, envIssue);
	const unset = asOptionalStringArray(object.unset, source, "unset") ?? [];
	const unsetIssue = unsetProblem(unset);
	if (unsetIssue !== undefined) fail(source, unsetIssue);
	const timeout_ms = asOptionalPositiveInteger(object.timeout_ms, source, "timeout_ms") ?? 60_000;
	if (timeout_ms > MAX_TIMER_MS) {
		fail(source, `timeout_ms must be at most ${MAX_TIMER_MS}: Node clamps a longer timer to 1 ms`);
	}
	return {
		id,
		area,
		binary: probe === undefined ? undefined : PROBES[probe],
		argv,
		env,
		unset,
		stdin: asStdin(object.stdin, source),
		files: asStringRecord(object.files, source, "files"),
		cwd: asWorkspaceDir(object.cwd, source),
		model: model === null ? null : { turns: asTurns(model.turns, source) },
		timeout_ms,
		compare: asCompareSpec(object.compare, source),
		skip,
		notApplicable,
	};
}

/** A relative path that stays inside the workspace. A cwd outside it would run the side in a tree the harness does not hash. */
function asWorkspaceDir(value: unknown, source: string): string | undefined {
	const dir = asOptionalString(value, source, "cwd");
	if (dir === undefined) return undefined;
	if (
		dir.length === 0 ||
		isAbsolute(dir) ||
		dir.split(/[\\/]/).some((part) => part === ".." || part.startsWith("$"))
	) {
		fail(source, "cwd must be a relative path inside the workspace");
	}
	return dir;
}

/** Resolves the case's probe name into the program it runs. Case data names a probe, never a path. */
function asProbeName(value: unknown, source: string): ProbeName | undefined {
	const probe = asOptionalString(value, source, "probe");
	if (probe === undefined) return undefined;
	if (!Object.hasOwn(PROBES, probe)) fail(source, `unknown probe "${probe}"`);
	return probe as ProbeName;
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
		files: asFileSpecs(object.files, source),
		absent: asAbsentPaths(object.absent, source),
		containment: asContainmentSpecs(object.containment, source),
		requests: asOptionalRequestSpecs(object.requests, source),
	};
}

function asFileSpecs(value: unknown, source: string): FileSpec[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) fail(source, "compare.files must be an array");
	return value.map((entry, index): FileSpec => {
		const field = `compare.files[${index}]`;
		if (typeof entry === "string") {
			assertWorkspaceRelative(entry, source, field);
			return entry;
		}
		const object = asCheckedObject(entry, source, field, FILE_SPEC_KEYS);
		const path = asString(object.path, source, `${field}.path`);
		assertWorkspaceRelative(path, source, `${field}.path`);
		return { path, contains: asOptionalStringArray(object.contains, source, `${field}.contains`) };
	});
}

/** A file assertion names a path inside the workspace, so it cannot read the host through `..`. */
function assertWorkspaceRelative(path: string, source: string, field: string): void {
	if (path.length === 0) fail(source, `${field} must not be empty`);
	if (path.startsWith("/") || path.split("/").includes("..")) {
		fail(source, `${field} must be relative to the workspace, without ".."`);
	}
	// The scan keys a tree by the path it walked, so these spellings could never match one.
	if (path.startsWith("./") || path.endsWith("/")) {
		fail(source, `${field} must be a plain workspace-relative path, without "./" or a trailing "/"`);
	}
}

function asAbsentPaths(value: unknown, source: string): string[] | undefined {
	const paths = asOptionalStringArray(value, source, "compare.absent");
	for (const path of paths ?? []) {
		if (!path.startsWith("/") && !path.startsWith("$")) {
			fail(source, `compare.absent path "${path}" must be absolute or start with a $ placeholder`);
		}
	}
	return paths;
}

function asContainmentSpecs(value: unknown, source: string): ContainmentSpec[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) fail(source, "compare.containment must be an array");
	return value.map((entry, index): ContainmentSpec => {
		const field = `compare.containment[${index}]`;
		const object = asCheckedObject(entry, source, field, CONTAINMENT_KEYS);
		const kind = asString(object.kind, source, `${field}.kind`);
		if ((HARNESS_FAILURE_KINDS as readonly string[]).includes(kind)) {
			fail(
				source,
				`${field}.kind "${kind}" is a harness failure that always fails the case, so a case cannot declare it`,
			);
		}
		if (!isPlantable(kind)) {
			fail(source, `${field}.kind "${kind}" is not a violation kind (${PLANTABLE_VIOLATION_KINDS.join(", ")})`);
		}
		const path = asOptionalString(object.path, source, `${field}.path`);
		if (kind === "survivor") {
			if (path !== undefined)
				fail(source, `${field}.path is a process, not a path in the tree, so it cannot be named`);
			return { kind };
		}
		if (path === undefined && (kind === "escaping-symlink" || kind === "dangling-symlink")) {
			fail(source, `${field}.path is required: a link that escapes or dangles is always inside the tree`);
		}
		if (path !== undefined) assertWorkspaceRelative(path, source, `${field}.path`);
		return { kind, path };
	});
}

function isPlantable(kind: string): kind is PlantableViolationKind {
	return (PLANTABLE_VIOLATION_KINDS as readonly string[]).includes(kind);
}

function asNotApplicable(value: unknown, source: string): Partial<Record<SideName, string>> {
	if (value === undefined) return {};
	const object = asObject(value, source, "not_applicable");
	const result: Partial<Record<SideName, string>> = {};
	for (const [key, reason] of Object.entries(object)) {
		if (!SIDE_NAMES.includes(key as SideName)) {
			fail(source, `not_applicable key "${key}" is not a side (${SIDE_NAMES.join(", ")})`);
		}
		const text = asString(reason, source, `not_applicable.${key}`);
		if (text.trim().length === 0) fail(source, `not_applicable.${key} needs a reason`);
		result[key as SideName] = text;
	}
	if (Object.keys(result).length === SIDE_NAMES.length) {
		fail(source, "not_applicable names every side, so the case would assert nothing");
	}
	return result;
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
		return {
			kind,
			records: asOptionalStringArray(object.records, source, "compare.stdout.records"),
			shape: object.shape,
		};
	}
	if (kind === "frames") {
		assertKnownKeys(object, FRAMES_STDOUT_KEYS, source, "compare.stdout");
		if (!Array.isArray(object.frames) || object.frames.length === 0) {
			return fail(source, "compare.stdout.frames must be a non-empty array of shapes");
		}
		return { kind, frames: object.frames };
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
		const method = asOptionalString(object.method, source, "method");
		if (method !== undefined && method.trim().length === 0) fail(source, "method must not be empty");
		return {
			pathStartsWith: asOptionalString(object.pathStartsWith, source, "pathStartsWith"),
			count: asOptionalNumber(object.count, source, "count"),
			method,
			headers: asRequestHeaders(object.headers, source, `${field}.headers`),
			bodyEquals: body as Record<string, unknown> | undefined,
			bodyIncludes: asOptionalStringArray(object.bodyIncludes, source, `${field}.bodyIncludes`),
			bodyExcludes: asOptionalStringArray(object.bodyExcludes, source, `${field}.bodyExcludes`),
			bodyMatch: asOptionalStringArray(object.bodyMatch, source, `${field}.bodyMatch`),
			bodyNotMatch: asOptionalStringArray(object.bodyNotMatch, source, `${field}.bodyNotMatch`),
			bodyAt: asBodyAt(object.bodyAt, source, `${field}.bodyAt`),
			bodyLength: asBodyLength(object.bodyLength, source, `${field}.bodyLength`),
			bodySame: asOptionalStringArray(object.bodySame, source, `${field}.bodySame`),
			index: asOptionalInteger(object.index, source, `${field}.index`),
		};
	});
}

function asBodyAt(value: unknown, source: string, field: string): Record<string, BodyTextSpec> | undefined {
	if (value === undefined) return undefined;
	const object = asObject(value, source, field);
	const specs: Record<string, BodyTextSpec> = {};
	for (const [path, entry] of Object.entries(object)) {
		if (path.length === 0 || path.split(".").some((segment) => segment.length === 0)) {
			fail(source, `${field} has an empty path segment in "${path}"`);
		}
		const spec = asCheckedObject(entry, source, `${field}.${path}`, BODY_TEXT_KEYS);
		const match = asOptionalStringArray(spec.match, source, `${field}.${path}.match`);
		const notMatch = asOptionalStringArray(spec.notMatch, source, `${field}.${path}.notMatch`);
		if (match === undefined && notMatch === undefined) fail(source, `${field}.${path} must set match or notMatch`);
		for (const pattern of [...(match ?? []), ...(notMatch ?? [])]) {
			try {
				toRegExp(pattern);
			} catch (error) {
				fail(source, `${field}.${path} has an invalid pattern ${JSON.stringify(pattern)}: ${String(error)}`);
			}
		}
		specs[path] = { match, notMatch };
	}
	return specs;
}

function asBodyLength(value: unknown, source: string, field: string): Record<string, BodyLengthSpec> | undefined {
	if (value === undefined) return undefined;
	const object = asObject(value, source, field);
	const specs: Record<string, BodyLengthSpec> = {};
	for (const [path, entry] of Object.entries(object)) {
		if (path.length === 0 || path.split(".").some((segment) => segment.length === 0)) {
			fail(source, `${field} has an empty path segment in "${path}"`);
		}
		const spec = asCheckedObject(entry, source, `${field}.${path}`, BODY_LENGTH_KEYS);
		const around = asOptionalNumber(spec.around, source, `${field}.${path}.around`);
		const tolerance = asOptionalNumber(spec.tolerance, source, `${field}.${path}.tolerance`);
		if (around === undefined || around <= 0) fail(source, `${field}.${path}.around must be a positive number`);
		if (tolerance !== undefined && (tolerance <= 0 || tolerance >= 1)) {
			fail(source, `${field}.${path}.tolerance must be between 0 and 1`);
		}
		specs[path] = { around, tolerance };
	}
	return specs;
}

function asOptionalInteger(value: unknown, source: string, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value)) fail(source, `${field} must be an integer`);
	return value;
}

/** A name is what the case compares, so an empty one could never match a recorded header. */
function asRequestHeaders(value: unknown, source: string, field: string): Record<string, HeaderValueSpec> | undefined {
	if (value === undefined) return undefined;
	const object = asObject(value, source, field);
	const headers: Record<string, HeaderValueSpec> = {};
	for (const [name, entry] of Object.entries(object)) {
		if (name.trim().length === 0) fail(source, `${field} has an empty header name`);
		headers[name] = asHeaderValue(entry, source, `${field}.${name}`);
	}
	return headers;
}

const HEADER_VALUE_KEYS = ["present", "contains", "excludes"];

function asHeaderValue(value: unknown, source: string, field: string): HeaderValueSpec {
	if (value === null || typeof value === "string") return value;
	const object = asCheckedObject(value, source, field, HEADER_VALUE_KEYS);
	const present = asOptionalBoolean(object.present, source, `${field}.present`);
	const contains = asOptionalStringArray(object.contains, source, `${field}.contains`);
	const excludes = asOptionalStringArray(object.excludes, source, `${field}.excludes`);
	if (present === undefined && contains === undefined && excludes === undefined) {
		fail(source, `${field} must set present, contains, or excludes, or be a string or null`);
	}
	return {
		...(present === undefined ? {} : { present }),
		...(contains === undefined ? {} : { contains }),
		...(excludes === undefined ? {} : { excludes }),
	};
}

function asTurns(value: unknown, source: string): Turn[] {
	if (!Array.isArray(value)) fail(source, "model.turns must be an array");
	return value.map((entry, index) => {
		const field = `model.turns[${index}]`;
		const object = asCheckedObject(entry, source, field, TURN_FIELDS);
		const kinds = TURN_KEYS.filter((key) => object[key] !== undefined);
		if (kinds.length !== 1) {
			const found = kinds.length === 0 ? "none" : kinds.join(", ");
			fail(source, `${field} must set exactly one of ${TURN_KEYS.join(", ")}, found ${found}`);
		}
		const kind = kinds[0];
		const holdMs = asOptionalInteger(object.hold_ms, source, `${field}.hold_ms`);
		if (holdMs !== undefined && (holdMs < 0 || holdMs > MAX_TIMER_MS)) {
			fail(source, `${field}.hold_ms must be between 0 and ${MAX_TIMER_MS}`);
		}
		const hold = holdMs === undefined ? {} : { hold_ms: holdMs };
		if (kind === "error") {
			if (object.hold_ms !== undefined) fail(source, `${field}.hold_ms does not apply to an error turn`);
			const error = asCheckedObject(object.error, source, `${field}.error`, ["status", "body"]);
			const status = asOptionalInteger(error.status, source, `${field}.error.status`);
			if (status === undefined) fail(source, `${field}.error.status is required`);
			return { error: { status, body: error.body } };
		}
		if (kind === "text") return { text: asString(object.text, source, `${field}.text`), ...hold };
		if (kind === "sse") {
			if (!Array.isArray(object.sse)) fail(source, `${field}.sse must be an array`);
			return { sse: object.sse, ...hold };
		}
		if (kind === "tool_use") return { tool_use: asToolUse(object.tool_use, source, `${field}.tool_use`), ...hold };
		if (!Array.isArray(object.tool_uses)) fail(source, `${field}.tool_uses must be an array`);
		return {
			tool_uses: object.tool_uses.map((toolUse) => asToolUse(toolUse, source, `${field}.tool_uses[]`)),
			...hold,
		};
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
		const lines = asOptionalStringArray(object.lines, source, "stdin.lines") ?? [];
		for (const line of lines) {
			if (line.startsWith("#sleep ")) {
				const value = line.slice("#sleep ".length);
				if (!/^\d+$/.test(value) || Number(value) > MAX_TIMER_MS) {
					fail(source, `stdin #sleep must be an integer between 0 and ${MAX_TIMER_MS}`);
				}
			} else if (line.startsWith("#waitfor ")) {
				try {
					new RegExp(line.slice("#waitfor ".length));
				} catch {
					fail(source, "stdin #waitfor must have a valid regular expression");
				}
			}
		}
		return { kind, lines };
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
