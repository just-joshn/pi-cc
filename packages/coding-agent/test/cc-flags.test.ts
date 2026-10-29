import { describe, expect, test } from "vitest";
import { formatVersionLine, NOT_LOGGED_IN_MESSAGE, PRINT_INPUT_REQUIRED_MESSAGE, parseArgs } from "../src/cli/args.ts";
import {
	CC_FLAGS,
	type CcDiagnostic,
	type CcFlag,
	formatCcHelpSection,
	formatDiagnosticPrefix,
	formatUnknownOptionMessage,
	validateSessionId,
} from "../src/cli/cc-flags.ts";
import { APP_NAME, VERSION } from "../src/config.ts";

function render(diagnostic: CcDiagnostic): string {
	return `${formatDiagnosticPrefix(diagnostic)}${diagnostic.message}`;
}

const SESSION_ID = "123e4567-e89b-12d3-a456-426614174000";

const SAMPLE_VALUES: Record<string, string> = {
	effort: "low",
	"json-schema": "{}",
	"max-budget-usd": "1",
	"session-id": SESSION_ID,
	"setting-sources": "user,project",
	tools: "read",
};

function sampleValue(flag: CcFlag): string {
	if (flag.choices) {
		return flag.choices.values[0];
	}
	return SAMPLE_VALUES[flag.name] ?? "sample";
}

function argvFor(spelling: string, flag: CcFlag): string[] {
	switch (flag.arity) {
		case "boolean":
			return [spelling];
		case "value":
			return [spelling, sampleValue(flag)];
		case "optional-value":
			return [spelling];
		case "variadic":
			return [spelling, sampleValue(flag)];
	}
}

describe("validation diagnostics", () => {
	test("rejects an unknown --output-format value", () => {
		const result = parseArgs(["-p", "hello", "--output-format", "nonsense"]);
		expect(result.diagnostics.map(render)).toEqual([
			"error: option '--output-format <format>' argument 'nonsense' is invalid. Allowed choices are text, json, stream-json.",
		]);
	});

	test("rejects an unknown --input-format value", () => {
		const result = parseArgs(["-p", "--input-format", "nonsense"]);
		expect(result.diagnostics.map(render)).toEqual([
			"error: option '--input-format <format>' argument 'nonsense' is invalid. Allowed choices are text, stream-json.",
		]);
	});

	test("rejects an unknown --permission-mode value", () => {
		const result = parseArgs(["-p", "hello", "--permission-mode", "nonsense"]);
		expect(result.diagnostics.map(render)).toEqual([
			"error: option '--permission-mode <mode>' argument 'nonsense' is invalid. Allowed choices are acceptEdits, auto, bypassPermissions, manual, dontAsk, plan.",
		]);
	});

	test("rejects a non-numeric --max-budget-usd value", () => {
		const result = parseArgs(["-p", "hello", "--max-budget-usd", "abc"]);
		expect(result.diagnostics.map(render)).toEqual([
			"error: option '--max-budget-usd <amount>' argument 'abc' is invalid. --max-budget-usd must be a positive number greater than 0",
		]);
		expect(result.maxBudgetUsd).toBeUndefined();
	});

	test("rejects a budget of zero", () => {
		const result = parseArgs(["-p", "hello", "--max-budget-usd", "0"]);
		expect(result.diagnostics.map(render)).toEqual([
			"error: option '--max-budget-usd <amount>' argument '0' is invalid. --max-budget-usd must be a positive number greater than 0",
		]);
	});

	test("accepts a positive budget", () => {
		const result = parseArgs(["-p", "hello", "--max-budget-usd", "1.5"]);
		expect(result.diagnostics).toEqual([]);
		expect(result.maxBudgetUsd).toBe(1.5);
	});

	test("leaves session-id validation to the session path", () => {
		const result = parseArgs(["-p", "hello", "--session-id", "not-a-uuid"]);
		expect(result.diagnostics).toEqual([]);
		expect(result.sessionId).toBe("not-a-uuid");
	});

	test("rejects a session ID that is not a UUID", () => {
		expect(validateSessionId("not-a-uuid")).toEqual({
			type: "error",
			message: "Invalid session ID. Must be a valid UUID.",
		});
		expect(validateSessionId(SESSION_ID)).toBeUndefined();
	});

	test("accepts a UUID session ID", () => {
		const result = parseArgs(["--session-id", SESSION_ID]);
		expect(result.diagnostics).toEqual([]);
		expect(result.sessionId).toBe(SESSION_ID);
	});

	test("rejects --json-schema that is not JSON and keeps the parser detail", () => {
		const result = parseArgs(["-p", "hello", "--json-schema", "{not json"]);
		expect(result.diagnostics).toHaveLength(1);
		expect(render(result.diagnostics[0]).startsWith("Error: --json-schema is not valid JSON: ")).toBe(true);
		expect(result.jsonSchema).toBeUndefined();
	});

	test("stores a valid --json-schema", () => {
		const result = parseArgs(["--json-schema", '{"type":"object"}']);
		expect(result.diagnostics).toEqual([]);
		expect(result.jsonSchema).toEqual({ type: "object" });
	});

	test("warns about an unknown --effort value and does not store it", () => {
		const result = parseArgs(["-p", "hello", "--effort", "nonsense"]);
		expect(result.diagnostics.map(render)).toEqual([
			"Warning: Unknown --effort value 'nonsense' — ignoring it and using the default effort. Valid values: low, medium, high, xhigh, max.",
		]);
		expect(result.effort).toBeUndefined();
	});

	test("accepts every documented --effort value", () => {
		for (const level of ["low", "medium", "high", "xhigh", "max"]) {
			const result = parseArgs(["--effort", level]);
			expect(result.diagnostics).toEqual([]);
			expect(result.effort).toBe(level);
		}
	});

	test("validates --permission-prompts against host and none", () => {
		expect(parseArgs(["--permission-prompts", "host"]).diagnostics).toEqual([]);
		expect(parseArgs(["--permission-prompts", "nonsense"]).diagnostics.map(render)).toEqual([
			"error: option '--permission-prompts <target>' argument 'nonsense' is invalid. Allowed choices are host, none.",
		]);
	});

	test("validates --system-prompt-snapshot against on and off", () => {
		expect(parseArgs(["--system-prompt-snapshot", "off"]).diagnostics).toEqual([]);
		expect(parseArgs(["--system-prompt-snapshot", "bogus"]).diagnostics.map(render)).toEqual([
			"error: option '--system-prompt-snapshot <on|off>' argument 'bogus' is invalid. Allowed choices are on, off.",
		]);
	});

	test("validates --setting-sources", () => {
		expect(parseArgs(["--setting-sources", "user,project,local"]).diagnostics).toEqual([]);
		expect(parseArgs(["--setting-sources", "user,bogus"]).diagnostics.map(render)).toEqual([
			"Error: Invalid setting source: bogus. Valid options are: user, project, local",
		]);
	});

	test("reports an unknown long flag the way Claude Code does", () => {
		const result = parseArgs(["--no-such-flag-probe"]);
		expect(result.unknownFlags.get("no-such-flag-probe")).toBe(true);
		expect(formatUnknownOptionMessage("--no-such-flag-probe")).toBe("unknown option '--no-such-flag-probe'");
	});

	test("reports an unknown short flag the way Claude Code does", () => {
		const result = parseArgs(["-Z"]);
		expect(result.diagnostics.map(render)).toEqual(["error: unknown option '-Z'"]);
	});

	test("pins the print-mode input error", () => {
		expect(PRINT_INPUT_REQUIRED_MESSAGE).toBe(
			"Error: Input must be provided either through stdin or as a prompt argument when using --print",
		);
	});

	test("pins the credential gate line", () => {
		expect(NOT_LOGGED_IN_MESSAGE).toBe("Not logged in. Run /login to authenticate.");
	});
});

describe("table arity", () => {
	test("a value flag consumes the next token even when it looks like a flag", () => {
		const result = parseArgs(["--max-budget-usd", "-5"]);
		expect(result.diagnostics.map(render)).toEqual([
			"error: option '--max-budget-usd <amount>' argument '-5' is invalid. --max-budget-usd must be a positive number greater than 0",
		]);
	});

	test("an optional-value flag stops at the next flag", () => {
		const result = parseArgs(["--debug", "--verbose"]);
		expect(result.diagnostics).toEqual([]);
		expect(result.debug).toBe(true);
		expect(result.verbose).toBe(true);
	});

	test("an optional-value flag takes a following token", () => {
		const result = parseArgs(["--debug", "hooks,mcp"]);
		expect(result.debug).toBe("hooks,mcp");
		expect(result.messages).toEqual([]);
	});

	test("a variadic flag collects tokens until the next flag", () => {
		const result = parseArgs(["--add-dir", "one", "two", "--verbose"]);
		expect(result.diagnostics).toEqual([]);
		expect(result.addDir).toEqual(["one", "two"]);
		expect(result.verbose).toBe(true);
		expect(result.messages).toEqual([]);
	});

	test("a variadic flag without tokens is a missing argument", () => {
		const result = parseArgs(["--add-dir"]);
		expect(result.diagnostics.map(render)).toEqual(["error: option '--add-dir <directories...>' argument missing"]);
	});

	test("a required value without a token is a missing argument", () => {
		const result = parseArgs(["--output-format"]);
		expect(result.diagnostics.map(render)).toEqual(["error: option '--output-format <format>' argument missing"]);
	});

	test("--flag=value works for table flags", () => {
		const result = parseArgs(["--output-format=json", "--permission-mode=plan"]);
		expect(result.diagnostics).toEqual([]);
		expect(result.outputFormat).toBe("json");
		expect(result.permissionMode).toBe("plan");
		expect(result.mode).toBe("json");
	});

	test("--resume takes an optional session reference and leaves the picker alone", () => {
		expect(parseArgs(["--resume"]).resume).toBe(true);
		expect(parseArgs(["--resume"]).session).toBeUndefined();
		const withValue = parseArgs(["--resume", "abc123"]);
		expect(withValue.resume).toBe(true);
		expect(withValue.session).toBe("abc123");
	});
});

describe("Claude Code output format", () => {
	test("maps --output-format onto the pi mode and print mode", () => {
		expect(parseArgs(["--output-format", "json"]).mode).toBe("json");
		expect(parseArgs(["--output-format", "text"]).print).toBe(true);
		expect(parseArgs(["--output-format", "stream-json"]).print).toBe(true);
	});
});

describe("existing pi parsing", () => {
	test("-p still swallows the next non-flag token as the prompt", () => {
		const result = parseArgs(["-p", "hello there"]);
		expect(result.print).toBe(true);
		expect(result.messages).toEqual(["hello there"]);
		expect(result.unknownFlags.size).toBe(0);
	});

	test("-p does not swallow a following flag", () => {
		const result = parseArgs(["-p", "--output-format", "json", "hello"]);
		expect(result.messages).toEqual(["hello"]);
		expect(result.outputFormat).toBe("json");
	});

	test("--tools and -t keep the comma-list semantics", () => {
		expect(parseArgs(["--tools", "read,bash"]).tools).toEqual(["read", "bash"]);
		expect(parseArgs(["-t", "read,bash"]).tools).toEqual(["read", "bash"]);
		expect(parseArgs(["-t", "+codemode,-write"]).tools).toEqual(["+codemode", "-write"]);
	});
});

describe("table round-trip", () => {
	test("the table covers 66 Claude Code flags", () => {
		expect(CC_FLAGS).toHaveLength(66);
	});

	test("the arity buckets match Claude Code's help", () => {
		const buckets: Record<string, number> = {};
		for (const flag of CC_FLAGS) {
			buckets[flag.arity] = (buckets[flag.arity] ?? 0) + 1;
		}
		expect(buckets).toEqual({ boolean: 27, value: 24, "optional-value": 8, variadic: 7 });
	});

	test("every spelling of every flag parses without landing in unknownFlags", () => {
		const failures: string[] = [];
		for (const flag of CC_FLAGS) {
			const spellings = [
				`--${flag.name}`,
				...(flag.aliases ?? []).map((alias) => `--${alias}`),
				...(flag.short ?? []).map((short) => `-${short}`),
			];
			for (const spelling of spellings) {
				const argv = argvFor(spelling, flag);
				const result = parseArgs(argv);
				const errors = result.diagnostics.filter((diagnostic) => diagnostic.type === "error");
				if (result.unknownFlags.size > 0 || errors.length > 0) {
					failures.push(
						`${argv.join(" ")}: unknown=[${[...result.unknownFlags.keys()].join(",")}] errors=[${errors
							.map((diagnostic) => diagnostic.message)
							.join("; ")}]`,
					);
				}
			}
		}
		expect(failures).toEqual([]);
	});

	test("every spelling appears in the generated help section", () => {
		const section = formatCcHelpSection();
		const missing = CC_FLAGS.flatMap((flag) =>
			[
				`--${flag.name}`,
				...(flag.aliases ?? []).map((alias) => `--${alias}`),
				...(flag.short ?? []).map((short) => `-${short}`),
			].filter((spelling) => !section.includes(spelling)),
		);
		expect(missing).toEqual([]);
	});

	test("the help section has one line per flag", () => {
		expect(formatCcHelpSection().split("\n")).toHaveLength(CC_FLAGS.length);
	});

	test("a help line is the padded flag spec followed by the summary", () => {
		const line = formatCcHelpSection()
			.split("\n")
			.find((entry) => entry.includes("--output-format"));
		expect(line).toBe("  --output-format <format>        Output format (text, json, stream-json)");
	});
});

describe("version line", () => {
	test("uses Claude Code's <version> (<product>) shape", () => {
		expect(formatVersionLine()).toMatch(/^\d+\.\d+\.\d+ \(pi\)$/);
	});

	test("names pi and the package version on one line", () => {
		expect(formatVersionLine()).toBe(`${VERSION} (${APP_NAME})`);
	});
});
