import { describe, expect, it } from "vitest";
import { type AnthropicOptions, stream } from "../src/api/anthropic-messages.ts";
import { normalizeContext } from "../src/compat.ts";
import type { CcWireProfile, Context, Model, SystemMessage } from "../src/types.ts";

interface WireBlock {
	type: string;
	text?: string;
	cache_control?: unknown;
}

interface Captured {
	betas?: string[];
	system?: WireBlock[];
	messages: Array<{ role: string; content: WireBlock[] | string }>;
	thinking?: { type: string; display?: string; block_binding?: unknown };
	output_config?: { effort?: string };
}

const model: Model<"anthropic-messages"> = {
	id: "claude-opus-5-5",
	name: "Claude Opus 5.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://127.0.0.1:9",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 128000,
	compat: { forceAdaptiveThinking: true, supportsMidConvoEffort: true, supportsMidConvoSystemMessages: true },
};

const ccWire: CcWireProfile = {
	billingHeader: "x-anthropic-billing-header: cc_version=1.0.0.abc; cc_entrypoint=sdk-cli;",
	effort: "medium",
	extraBetas: ["extra-beta-1"],
};

const head: SystemMessage = {
	role: "system",
	content: "",
	sections: { identity: "IDENTITY", working: "WORKING" },
	context: "MACHINE CONTEXT",
	timestamp: 1,
};

async function capture(
	target: Model<"anthropic-messages">,
	context: Context,
	options: Partial<AnthropicOptions> = {},
): Promise<Captured> {
	let payload: Captured | undefined;
	await stream(target, normalizeContext(context), {
		apiKey: "test-key",
		thinkingEnabled: true,
		effort: "low",
		...options,
		onPayload: (value) => {
			payload = value as Captured;
			throw new Error("payload captured");
		},
	}).result();
	if (!payload) throw new Error("Expected payload capture");
	return payload;
}

const firstUser = { role: "user" as const, content: "hello", timestamp: 2 };

describe("Claude Code wire profile", () => {
	it("splits the system prompt into billing, identity and working blocks", async () => {
		const payload = await capture(model, { messages: [head, firstUser] }, { ccWire });

		expect(payload.system?.map((block) => block.text)).toEqual([ccWire.billingHeader, "IDENTITY", "WORKING"]);
		expect(payload.system?.map((block) => block.cache_control !== undefined)).toEqual([false, true, true]);
	});

	it("places the machine context in a system message after the first user message", async () => {
		const payload = await capture(model, { messages: [head, firstUser] }, { ccWire });

		expect(payload.messages.map((message) => message.role)).toEqual(["user", "system"]);
		expect(payload.messages[1].content).toMatchObject([{ type: "text", text: "MACHINE CONTEXT" }]);
	});

	it("sends effort directly with omitted thinking, no binding and no effort markers", async () => {
		const payload = await capture(model, { messages: [head, firstUser] }, { ccWire });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "omitted" });
		expect(payload.output_config).toEqual({ effort: "medium" });
		expect(payload.messages.every((message) => message.role !== "system" || message.content.length > 0)).toBe(true);
	});

	it("sends no output_config when the profile carries no effort", async () => {
		const payload = await capture(
			model,
			{ messages: [head, firstUser] },
			{ ccWire: { ...ccWire, effort: undefined } },
		);

		expect(payload.output_config).toBeUndefined();
	});

	it("appends extra betas to the automatic list", async () => {
		const payload = await capture(model, { messages: [head, firstUser] }, { ccWire });

		expect(payload.betas).toContain("extra-beta-1");
		expect(payload.betas?.length).toBeGreaterThan(1);
	});

	it("keeps pi's single block, markers and pinned effort without a profile", async () => {
		const payload = await capture(model, { messages: [head, firstUser] });

		expect(payload.system).toHaveLength(1);
		expect(payload.output_config).toEqual({ effort: "low" });
		expect(payload.thinking).toMatchObject({ block_binding: { prefix_mismatch_behavior: "drop_block" } });
		expect(payload.messages.at(-1)?.role).toBe("system");
	});

	it("folds a head without the identity split into one block after the billing line", async () => {
		const forced: SystemMessage = { role: "system", content: "FORCED", timestamp: 1 };
		const payload = await capture(model, { messages: [forced, firstUser] }, { ccWire });

		expect(payload.system?.map((block) => block.text)).toEqual([ccWire.billingHeader, "FORCED"]);
	});

	it("appends the context to the working block for a model without mid-conversation system messages", async () => {
		const plain: Model<"anthropic-messages"> = {
			...model,
			compat: { forceAdaptiveThinking: true },
		};
		const payload = await capture(plain, { messages: [head, firstUser] }, { ccWire });

		expect(payload.system?.[2].text).toBe("WORKING\n\nMACHINE CONTEXT");
		expect(payload.messages.map((message) => message.role)).toEqual(["user"]);
	});
});
