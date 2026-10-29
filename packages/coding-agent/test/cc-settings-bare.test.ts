import { describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { ccResourceSuppression } from "../src/main.ts";

describe("resource suppression", () => {
	test("--safe-mode disables MCP servers", () => {
		expect(ccResourceSuppression(parseArgs(["--safe-mode"])).noMcp).toBe(true);
	});

	test("--bare leaves MCP servers alone", () => {
		expect(ccResourceSuppression(parseArgs(["--bare"])).noMcp).toBe(false);
	});

	test("--no-mcp still disables them", () => {
		expect(ccResourceSuppression(parseArgs(["--no-mcp"])).noMcp).toBe(true);
	});
});
