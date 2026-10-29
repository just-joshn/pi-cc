import { describe, expect, it } from "vitest";
import {
	ccModelAlias,
	hasModelEnvironment,
	isModelAlias,
	parseAnthropicModelEnv,
} from "../src/core/anthropic-model-env.ts";

describe("parseAnthropicModelEnv", () => {
	it("reads the session model and one variable per family", () => {
		const env = parseAnthropicModelEnv({
			ANTHROPIC_MODEL: "haiku",
			ANTHROPIC_DEFAULT_OPUS_MODEL: "opus-id",
			ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet-id",
			ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku-id",
			ANTHROPIC_DEFAULT_FABLE_MODEL: "fable-id",
		});

		expect(env).toEqual({
			model: "haiku",
			family: { opus: "opus-id", sonnet: "sonnet-id", haiku: "haiku-id", fable: "fable-id" },
		});
	});

	it("trims values and drops empty ones", () => {
		expect(parseAnthropicModelEnv({ ANTHROPIC_MODEL: "  haiku  ", ANTHROPIC_DEFAULT_HAIKU_MODEL: "   " })).toEqual({
			model: "haiku",
			family: {},
		});
	});

	it("ignores ANTHROPIC_SMALL_FAST_MODEL, which does not name the session model", () => {
		const env = parseAnthropicModelEnv({
			ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-4-5",
			ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-5-5",
		});

		expect(env.family.haiku).toBe("claude-haiku-5-5");
	});
});

describe("ccModelAlias", () => {
	const env = parseAnthropicModelEnv({
		ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5",
		ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5-5",
		ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-5-5",
		ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-fable-5-1",
	});

	it("maps each family alias to its variable", () => {
		expect(ccModelAlias("opus", env)).toBe("claude-opus-5-5");
		expect(ccModelAlias("sonnet", env)).toBe("claude-sonnet-5-5");
		expect(ccModelAlias("haiku", env)).toBe("claude-haiku-5-5");
		expect(ccModelAlias("fable", env)).toBe("claude-fable-5-1");
	});

	it("trims and lowercases the alias", () => {
		expect(ccModelAlias("  Haiku ", env)).toBe("claude-haiku-5-5");
	});

	it("leaves any other name unchanged", () => {
		expect(ccModelAlias("claude-haiku-4-5", env)).toBe("claude-haiku-4-5");
		expect(ccModelAlias("glm-4.6", env)).toBe("glm-4.6");
	});

	it("names the build's family default when no variable redefines the alias", () => {
		const bare = parseAnthropicModelEnv({});

		expect(ccModelAlias("opus", bare)).toBe("claude-opus-5-5");
		expect(ccModelAlias("sonnet", bare)).toBe("claude-sonnet-4-6");
		expect(ccModelAlias("haiku", bare)).toBe("claude-haiku-4-5");
		expect(ccModelAlias("fable", bare)).toBe("claude-fable-5-1");
	});
});

describe("hasModelEnvironment", () => {
	it("is true only when a session model or a family variable is set", () => {
		expect(hasModelEnvironment(parseAnthropicModelEnv({}))).toBe(false);
		expect(hasModelEnvironment(parseAnthropicModelEnv({ ANTHROPIC_MODEL: "haiku" }))).toBe(true);
		expect(hasModelEnvironment(parseAnthropicModelEnv({ ANTHROPIC_DEFAULT_HAIKU_MODEL: "x" }))).toBe(true);
		expect(hasModelEnvironment(parseAnthropicModelEnv({ ANTHROPIC_SMALL_FAST_MODEL: "x" }))).toBe(false);
	});
});

describe("isModelAlias", () => {
	it("accepts only a bare family name, in any case and with spaces", () => {
		expect(isModelAlias(" opus ")).toBe(true);
		expect(isModelAlias("FABLE")).toBe(true);
		expect(isModelAlias("opusplan")).toBe(false);
		expect(isModelAlias("claude-opus-5-5")).toBe(false);
	});
});
