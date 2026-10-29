import type { CompareSpec, FileSpec, StdoutSpec } from "./case.ts";
import type { RecordedRequest } from "./mock/messages.ts";
import type { NormalizeContext } from "./normalize/stdout.ts";
import { normalizeText, normalizeWhitespace } from "./normalize/stdout.ts";

export interface Observation {
	timedOut: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	requests: RecordedRequest[];
	workspaceBefore: Map<string, string>;
	workspaceAfter: Map<string, string>;
	/** Text of the `compare.files` paths that exist after the run. */
	fileText: Map<string, string>;
	/** `compare.absent` paths that exist after the run, which is a containment failure. */
	forbiddenPathsFound: string[];
}

export interface Diff {
	check: string;
	expected: string;
	actual: string;
}

const APP_NAMES = new Set(["claude", "pi", "pi-cc"]);

export function compare(spec: CompareSpec, observation: Observation, context: NormalizeContext): Diff[] {
	const diffs: Diff[] = [];
	checkExit(spec, observation, diffs);
	checkStdout(spec.stdout, observation, context, diffs);
	checkStderr(spec.stderr, observation, diffs);
	checkFiles(spec.files, observation, diffs);
	checkAbsent(observation, diffs);
	checkRequests(spec.requests, observation, diffs);
	return diffs;
}

function checkExit(spec: CompareSpec, observation: Observation, diffs: Diff[]): void {
	if (spec.exit === undefined) return;
	const expected = Array.isArray(spec.exit) ? spec.exit : [spec.exit];
	const actual = observation.timedOut ? "timeout" : String(observation.exitCode);
	if (observation.timedOut || !expected.includes(observation.exitCode ?? Number.NaN)) {
		diffs.push({ check: "exit", expected: expected.join(" or "), actual });
	}
}

function checkStdout(
	spec: StdoutSpec | undefined,
	observation: Observation,
	context: NormalizeContext,
	diffs: Diff[],
): void {
	if (spec === undefined) return;
	if (spec.kind === "text") {
		const raw = observation.stdout;
		for (const pattern of spec.match ?? []) {
			if (!toRegExp(pattern).test(raw)) {
				diffs.push({ check: "stdout.match", expected: `match /${pattern}/`, actual: firstLine(raw) });
			}
		}
		if (spec.equals !== undefined) {
			const actual = normalizeText(raw, spec.normalize ?? ["whitespace"], context);
			const expected = normalizeWhitespace(spec.equals);
			if (actual !== expected) diffs.push({ check: "stdout", expected, actual });
		}
		return;
	}
	if (spec.kind === "help") {
		const names = parseHelpNames(observation.stdout);
		const missingFlags = (spec.requireFlags ?? []).filter((flag) => !names.flags.has(flag));
		const missingCommands = (spec.requireCommands ?? []).filter((command) => !names.commands.has(command));
		if (missingFlags.length > 0) {
			diffs.push({ check: "stdout.help", expected: "flags present", actual: `missing ${missingFlags.join(", ")}` });
		}
		if (missingCommands.length > 0) {
			diffs.push({
				check: "stdout.help",
				expected: "commands present",
				actual: `missing ${missingCommands.join(", ")}`,
			});
		}
		if (!spec.allowExtra) {
			const extraFlags = [...names.flags].filter((flag) => !(spec.requireFlags ?? []).includes(flag));
			const extraCommands = [...names.commands].filter((command) => !(spec.requireCommands ?? []).includes(command));
			if (extraFlags.length > 0) {
				diffs.push({ check: "stdout.help", expected: "no extra flags", actual: `extra ${extraFlags.join(", ")}` });
			}
			if (extraCommands.length > 0) {
				diffs.push({
					check: "stdout.help",
					expected: "no extra commands",
					actual: `extra ${extraCommands.join(", ")}`,
				});
			}
		}
		return;
	}
	if (spec.kind === "jsonl") {
		checkJsonLines(spec, observation, diffs);
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(normalizeWhitespace(observation.stdout));
	} catch (error) {
		diffs.push({ check: "stdout.json", expected: "one JSON record", actual: String(error) });
		return;
	}
	const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	for (const key of spec.records ?? []) {
		if (!(key in record)) diffs.push({ check: "stdout.json", expected: `has "${key}"`, actual: "absent" });
	}
}

function checkJsonLines(
	spec: { minRecords?: number; records?: string[] },
	observation: Observation,
	diffs: Diff[],
): void {
	const lines = observation.stdout.split("\n").filter((line) => line.trim().length > 0);
	const records: Record<string, unknown>[] = [];
	for (const [index, line] of lines.entries()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			diffs.push({ check: "stdout.jsonl", expected: `record ${index} parses`, actual: String(error) });
			return;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			diffs.push({ check: "stdout.jsonl", expected: `record ${index} is a JSON object`, actual: typeof parsed });
			return;
		}
		records.push(parsed as Record<string, unknown>);
	}
	const minimum = spec.minRecords ?? 1;
	if (records.length < minimum) {
		diffs.push({
			check: "stdout.jsonl",
			expected: `at least ${minimum} record`,
			actual: `${records.length} records`,
		});
	}
	for (const key of spec.records ?? []) {
		const missing = records.findIndex((record) => !(key in record));
		if (missing !== -1) {
			diffs.push({ check: "stdout.jsonl", expected: `record ${missing} has "${key}"`, actual: "absent" });
		}
	}
}

function checkStderr(spec: CompareSpec["stderr"], observation: Observation, diffs: Diff[]): void {
	if (spec === undefined) return;
	for (const fragment of spec.contains ?? []) {
		if (!observation.stderr.includes(fragment)) {
			diffs.push({ check: "stderr.contains", expected: fragment, actual: firstLine(observation.stderr) });
		}
	}
	if (spec.equals !== undefined) {
		const actual = normalizeWhitespace(observation.stderr);
		const expected = normalizeWhitespace(spec.equals);
		if (actual !== expected) diffs.push({ check: "stderr", expected, actual });
	}
}

function checkFiles(expected: FileSpec[] | undefined, observation: Observation, diffs: Diff[]): void {
	const before = observation.workspaceBefore;
	const after = observation.workspaceAfter;
	const changed = new Set<string>();
	for (const [path, hash] of after) if (before.get(path) !== hash) changed.add(path);
	for (const path of before.keys()) if (!after.has(path)) changed.add(path);
	for (const spec of expected ?? []) {
		const path = typeof spec === "string" ? spec : spec.path;
		if (!after.has(path)) {
			diffs.push({ check: "files", expected: `${path} written`, actual: "absent" });
		} else if (typeof spec !== "string") {
			const text = observation.fileText.get(path) ?? "";
			for (const fragment of spec.contains ?? []) {
				if (text.includes(fragment)) continue;
				diffs.push({ check: "files.contains", expected: `${path} contains ${fragment}`, actual: firstLine(text) });
			}
		}
		changed.delete(path);
	}
	for (const path of [...changed].sort()) {
		diffs.push({ check: "files", expected: "no unexpected write", actual: `${path} changed` });
	}
}

function checkAbsent(observation: Observation, diffs: Diff[]): void {
	for (const path of observation.forbiddenPathsFound) {
		diffs.push({ check: "files.absent", expected: `${path} absent`, actual: "present" });
	}
}

function checkRequests(spec: CompareSpec["requests"], observation: Observation, diffs: Diff[]): void {
	for (const request of spec ?? []) {
		const matched = observation.requests.filter(
			(record) => request.pathStartsWith === undefined || record.path.startsWith(request.pathStartsWith),
		);
		if (request.count !== undefined && matched.length !== request.count) {
			diffs.push({
				check: "requests.count",
				expected: `${request.count} requests to ${request.pathStartsWith ?? "*"}`,
				actual: `${matched.length} requests (${matched.map((record) => record.path).join(", ") || "none"})`,
			});
		}
		if (request.bodyEquals !== undefined) {
			const hit = matched.find((record) => matchesSubset(record.body, request.bodyEquals));
			if (hit === undefined) {
				diffs.push({
					check: "requests.body",
					expected: JSON.stringify(request.bodyEquals),
					actual: matched.length === 0 ? "no matching request" : JSON.stringify(matched[0].body),
				});
			}
		}
	}
}

function parseHelpNames(text: string): { flags: Set<string>; commands: Set<string> } {
	const flags = new Set<string>();
	const commands = new Set<string>();
	for (const line of text.split("\n")) {
		const entry = /^ {2}(\S.*)$/.exec(line);
		if (!entry) continue;
		const head = entry[1].split(/ {3,}/)[0].trimEnd();
		if (head.startsWith("-")) {
			for (const token of head.split(/[,\s]+/)) {
				if (/^--?[A-Za-z0-9][\w-]*$/.test(token)) flags.add(token);
			}
			continue;
		}
		const tokens = head.split(/\s+/);
		if (tokens.length > 1 && APP_NAMES.has(tokens[0])) tokens.shift();
		for (const name of tokens[0].split("|")) {
			if (name.length > 0 && !APP_NAMES.has(name)) commands.add(name);
		}
	}
	return { flags, commands };
}

function matchesSubset(actual: unknown, expected: unknown): boolean {
	if (Array.isArray(expected)) {
		return (
			Array.isArray(actual) &&
			actual.length === expected.length &&
			expected.every((entry, index) => matchesSubset(actual[index], entry))
		);
	}
	if (typeof expected === "object" && expected !== null) {
		if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
		const record = actual as Record<string, unknown>;
		return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
			matchesSubset(record[key], value),
		);
	}
	return actual === expected;
}

/** Case files spell the case-insensitive flag inline, which JavaScript regular expressions do not support. */
function toRegExp(pattern: string): RegExp {
	const inline = /^\(\?([ims]+)\)/.exec(pattern);
	if (inline === null) return new RegExp(pattern, "m");
	return new RegExp(pattern.slice(inline[0].length), `${inline[1]}m`);
}

function firstLine(text: string): string {
	const line = text.split("\n").find((entry) => entry.trim().length > 0);
	return line === undefined ? "(empty)" : line.trim().slice(0, 400);
}
