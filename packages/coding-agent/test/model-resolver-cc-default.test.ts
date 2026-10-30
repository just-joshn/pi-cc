import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	anthropicCcModel,
	defaultModelPerProvider,
	findInitialModel,
	resolveCliModel,
} from "../src/core/model-resolver.ts";

const opus55 = getModel("anthropic", "claude-opus-5-5")!;
const opus48 = getModel("anthropic", "claude-opus-4-8")!;

function runtime(models = [opus48, opus55]) {
	return {
		getModel: (provider: string, modelId: string) =>
			models.find((model) => model.provider === provider && model.id === modelId),
		getModels: () => models,
		hasConfiguredAuth: (provider: string) => provider === "anthropic",
		getAvailableSnapshot: () => models,
	} as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];
}

describe("default Anthropic model", () => {
	const saved = process.env.ANTHROPIC_BASE_URL;
	beforeEach(() => {
		delete process.env.ANTHROPIC_BASE_URL;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
		else process.env.ANTHROPIC_BASE_URL = saved;
	});

	test("is claude-opus-5-5 when nothing is configured", async () => {
		expect(defaultModelPerProvider.anthropic).toBe("claude-opus-5-5");

		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRuntime: runtime(),
			env: {},
		});

		expect(result.model?.id).toBe("claude-opus-5-5");
	});

	test("yields to the model the operator saved in settings", async () => {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "anthropic",
			defaultModelId: "claude-opus-4-8",
			modelRuntime: runtime(),
			env: {},
		});

		expect(result.model?.id).toBe("claude-opus-4-8");
	});

	test("--model claude-opus-4-1 resolves to the Opus default on Anthropic without a base URL", () => {
		const result = resolveCliModel({ cliModel: "claude-opus-4-1", modelRuntime: runtime() });

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("anthropic");
		expect(result.model?.id).toBe("claude-opus-5-5");
	});

	test("a model id outside the catalog is sent as written with Claude Code's 32000 output cap", () => {
		const model = anthropicCcModel(runtime(), "claude-probe-alias-x", {});

		expect(model?.id).toBe("claude-probe-alias-x");
		expect(model?.maxTokens).toBe(32_000);
	});

	test("a model id in the catalog keeps its own output cap", () => {
		expect(anthropicCcModel(runtime(), "claude-opus-5-5", {})?.maxTokens).toBe(opus55.maxTokens);
	});
});
