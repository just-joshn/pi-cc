import { describe, expect, it } from "vitest";
import {
	ccModelAlias,
	ccSettingsModelMigration,
	hasModelEnvironment,
	isModelAlias,
	parseAnthropicModelEnv,
	stripContextMarkers,
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
			legacyRemapDisabled: false,
		});
	});

	it("trims values and drops empty ones", () => {
		expect(parseAnthropicModelEnv({ ANTHROPIC_MODEL: "  haiku  ", ANTHROPIC_DEFAULT_HAIKU_MODEL: "   " })).toEqual({
			model: "haiku",
			family: {},
			legacyRemapDisabled: false,
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
		expect(ccModelAlias("sonnet", bare)).toBe("claude-sonnet-5-5");
		expect(ccModelAlias("haiku", bare)).toBe("claude-haiku-5-5");
		expect(ccModelAlias("fable", bare)).toBe("claude-fable-5-1");
	});

	it("resolves opusplan to the Sonnet default, which its variable redefines", () => {
		const bare = parseAnthropicModelEnv({});
		const pinned = parseAnthropicModelEnv({ ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-4.6" });

		expect(ccModelAlias("opusplan", bare)).toBe("claude-sonnet-5-5");
		expect(ccModelAlias("opusplan", pinned)).toBe("glm-4.6");
	});

	it("resolves best to the Fable default, which its variable redefines", () => {
		const bare = parseAnthropicModelEnv({});
		const pinned = parseAnthropicModelEnv({ ANTHROPIC_DEFAULT_FABLE_MODEL: "glm-4.6" });

		expect(ccModelAlias("best", bare)).toBe("claude-fable-5-1");
		expect(ccModelAlias("best", pinned)).toBe("glm-4.6");
	});

	it("carries a [1m] marker from an alias through to the resolved id", () => {
		const bare = parseAnthropicModelEnv({});

		expect(ccModelAlias("opus[1m]", bare)).toBe("claude-opus-5-5[1m]");
		expect(ccModelAlias("OPUS[1M]", bare)).toBe("claude-opus-5-5[1m]");
		expect(ccModelAlias("opusplan[1m]", bare)).toBe("claude-sonnet-5-5[1m]");
		expect(ccModelAlias("best[1m]", bare)).toBe("claude-fable-5-1[1m]");
		// A doubled marker is not an alias form; it collapses like any other name's trailing run.
		expect(ccModelAlias("opus[1m][1m]", bare)).toBe("opus[1m]");
	});

	it("collapses a trailing [1m] run on a non-alias name and leaves anything else as written", () => {
		const bare = parseAnthropicModelEnv({});

		expect(ccModelAlias("claude-sonnet-5-5[1m]", bare)).toBe("claude-sonnet-5-5[1m]");
		expect(ccModelAlias("pi-unknown[1m]", bare)).toBe("pi-unknown[1m]");
		expect(ccModelAlias("default", bare)).toBe("default");
		expect(ccModelAlias("pi-unknown", bare)).toBe("pi-unknown");
	});

	it("remaps a retired Opus id to the Opus default", () => {
		const bare = parseAnthropicModelEnv({});

		expect(ccModelAlias("claude-opus-4-0", bare)).toBe("claude-opus-5-5");
		expect(ccModelAlias("claude-opus-4-1", bare)).toBe("claude-opus-5-5");
		expect(ccModelAlias("claude-opus-4-1-20250805", bare)).toBe("claude-opus-5-5");
		expect(ccModelAlias("claude-opus-4-0[1m]", bare)).toBe("claude-opus-5-5[1m]");
	});

	it("keeps a retired id as written when the legacy remap is disabled", () => {
		const disabled = parseAnthropicModelEnv({ CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP: "1" });

		expect(ccModelAlias("claude-opus-4-0", disabled)).toBe("claude-opus-4-0");
		expect(parseAnthropicModelEnv({ CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP: "" }).legacyRemapDisabled).toBe(false);
	});
});

describe("ccSettingsModelMigration", () => {
	it("rewrites exactly sonnet[1m] to the dated Sonnet 4.5 id", () => {
		expect(ccSettingsModelMigration("sonnet[1m]")).toBe("sonnet-4-5-20250929[1m]");
		expect(ccSettingsModelMigration("sonnet")).toBe("sonnet");
		expect(ccSettingsModelMigration("SONNET[1M]")).toBe("SONNET[1M]");
		expect(ccSettingsModelMigration("sonnet-4-5-20250929[1m]")).toBe("sonnet-4-5-20250929[1m]");
	});
});

describe("stripContextMarkers", () => {
	it("strips every [1m]/[2m] marker wherever it appears", () => {
		expect(stripContextMarkers("pi-unknown[1m]")).toBe("pi-unknown");
		expect(stripContextMarkers("claude-sonnet-5-5[1m]")).toBe("claude-sonnet-5-5");
		expect(stripContextMarkers("weird[1m]id[2m]")).toBe("weirdid");
		expect(stripContextMarkers("glm-4.6")).toBe("glm-4.6");
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
