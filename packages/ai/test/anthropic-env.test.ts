import { describe, expect, it } from "vitest";
import type { AuthContext } from "../src/auth/types.ts";
import { parseCustomHeaders, readAnthropicEnvironment } from "../src/providers/anthropic-env.ts";

function context(env: Record<string, string | undefined>): AuthContext {
	return { env: async (name) => env[name], fileExists: async () => false };
}

describe("parseCustomHeaders", () => {
	it("trims the name and the value", () => {
		expect(parseCustomHeaders("  x-case-one  :   one  ")).toEqual({ "x-case-one": "one" });
	});

	it("splits on the first colon only", () => {
		expect(parseCustomHeaders("x-forward: http://host:8080/path")).toEqual({
			"x-forward": "http://host:8080/path",
		});
	});

	it("skips a line without a colon", () => {
		expect(parseCustomHeaders("x-kept: yes\nno-colon-line")).toEqual({ "x-kept": "yes" });
	});

	it("skips a line with an empty name", () => {
		expect(parseCustomHeaders(": orphan-value\nx-kept: yes")).toEqual({ "x-kept": "yes" });
	});

	it("keeps an empty value", () => {
		expect(parseCustomHeaders("x-empty:")).toEqual({ "x-empty": "" });
	});

	it("accepts CRLF line endings", () => {
		expect(parseCustomHeaders("x-one: 1\r\nx-two: 2\r\n")).toEqual({ "x-one": "1", "x-two": "2" });
	});

	it("lets a later duplicate win case-insensitively with the later spelling", () => {
		expect(parseCustomHeaders("X-Dup: first\nx-dup: second")).toEqual({ "x-dup": "second" });
	});

	it("is undefined when nothing parses and when the text is absent", () => {
		expect(parseCustomHeaders("no-colon")).toBeUndefined();
		expect(parseCustomHeaders(undefined)).toBeUndefined();
	});
});

describe("readAnthropicEnvironment", () => {
	it("trims the base URL and reads the header text", async () => {
		await expect(
			readAnthropicEnvironment(
				context({
					ANTHROPIC_BASE_URL: "  https://gateway.example  ",
					ANTHROPIC_CUSTOM_HEADERS: "x-case: one",
				}),
			),
		).resolves.toEqual({ baseUrl: "https://gateway.example", headers: { "x-case": "one" } });
	});

	it("treats an empty or whitespace-only base URL as unset", async () => {
		await expect(readAnthropicEnvironment(context({ ANTHROPIC_BASE_URL: "   " }))).resolves.toBeUndefined();
	});

	it("is undefined when neither variable is set, so auth gains no baseUrl key at all", async () => {
		await expect(readAnthropicEnvironment(context({}))).resolves.toBeUndefined();
	});

	it("marks the environment authenticated only for a non-empty authorization or x-api-key", async () => {
		await expect(
			readAnthropicEnvironment(context({ ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer token" })),
		).resolves.toEqual({ headers: { Authorization: "Bearer token" }, authenticated: true });
		await expect(readAnthropicEnvironment(context({ ANTHROPIC_CUSTOM_HEADERS: "x-api-key: key" }))).resolves.toEqual({
			headers: { "x-api-key": "key" },
			authenticated: true,
		});
		await expect(readAnthropicEnvironment(context({ ANTHROPIC_CUSTOM_HEADERS: "x-api-key:" }))).resolves.toEqual({
			headers: { "x-api-key": "" },
		});
		await expect(readAnthropicEnvironment(context({ ANTHROPIC_CUSTOM_HEADERS: "x-trace: 1" }))).resolves.toEqual({
			headers: { "x-trace": "1" },
		});
	});
});
