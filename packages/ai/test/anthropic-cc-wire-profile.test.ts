import { describe, expect, it } from "vitest";
import { type AnthropicOptions, stream, streamSimple } from "../src/api/anthropic-messages.ts";
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
	effort: "medium",
	levelChosen: false,
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
	it("sends only the identity and working blocks without client attribution", async () => {
		const payload = await capture(model, { messages: [head, firstUser] }, { ccWire });

		expect(payload.system?.map((block) => block.text)).toEqual(["IDENTITY", "WORKING"]);
		expect(payload.system?.map((block) => block.cache_control !== undefined)).toEqual([true, true]);
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

	it("sends no output_config when neither the profile nor the options carry an effort", async () => {
		const payload = await capture(
			model,
			{ messages: [head, firstUser] },
			{ ccWire: { ...ccWire, effort: undefined }, effort: undefined },
		);

		expect(payload.output_config).toBeUndefined();
	});

	it("appends extra betas and leaves out the betas only effort markers and block binding need", async () => {
		const payload = await capture(model, { messages: [head, firstUser] }, { ccWire });

		expect(payload.betas).toEqual(["extra-beta-1"]);
	});

	it("keeps pi's single block, markers and pinned effort without a profile", async () => {
		const payload = await capture(model, { messages: [head, firstUser] });

		expect(payload.system).toHaveLength(1);
		expect(payload.betas).toContain("mid-conversation-output-config-2026-07-01");
		expect(payload.output_config).toEqual({ effort: "low" });
		expect(payload.thinking).toMatchObject({ block_binding: { prefix_mismatch_behavior: "drop_block" } });
		expect(payload.messages.at(-1)?.role).toBe("system");
	});

	it("folds a head without the identity split into one block", async () => {
		const forced: SystemMessage = { role: "system", content: "FORCED", timestamp: 1 };
		const payload = await capture(model, { messages: [forced, firstUser] }, { ccWire });

		expect(payload.system?.map((block) => block.text)).toEqual(["FORCED"]);
	});

	it("joins the working text and its session-specific part into the working block", async () => {
		const withDynamic: SystemMessage = {
			...head,
			sections: { identity: "IDENTITY", working: "WORKING", dynamic: "DYNAMIC" },
		};
		const payload = await capture(model, { messages: [withDynamic, firstUser] }, { ccWire });

		expect(payload.system?.[1].text).toBe("WORKING\n\nDYNAMIC");
	});

	it("leads the first user message with the context for a model without mid-conversation system messages", async () => {
		const plain: Model<"anthropic-messages"> = { ...model, compat: { forceAdaptiveThinking: true } };
		const payload = await capture(plain, { messages: [head, firstUser] }, { ccWire });

		expect(payload.messages.map((message) => message.role)).toEqual(["user"]);
		expect(payload.messages[0].content).toMatchObject([
			{ type: "text", text: "<system-reminder>\nMACHINE CONTEXT\n</system-reminder>" },
			{ type: "text", text: "hello" },
		]);
	});

	it("sends one empty effort-marker system message when the record carries no context", async () => {
		const bare: SystemMessage = {
			role: "system",
			content: "",
			sections: { identity: "I", working: "W" },
			timestamp: 1,
		};
		const payload = await capture(model, { messages: [bare, firstUser] }, { ccWire });

		expect(payload.messages.map((message) => message.role)).toEqual(["user", "system"]);
		expect(payload.messages[1]).toMatchObject({ content: [], output_config: { effort: "medium" } });
	});

	describe("through streamSimple", () => {
		async function captureSimple(
			target: Model<"anthropic-messages">,
			profile: CcWireProfile,
		): Promise<Captured & { max_tokens: number }> {
			let payload: (Captured & { max_tokens: number }) | undefined;
			await streamSimple(target, normalizeContext({ messages: [head, firstUser] }), {
				apiKey: "test-key",
				reasoning: "medium",
				ccWire: profile,
				onPayload: (value) => {
					payload = value as Captured & { max_tokens: number };
					throw new Error("payload captured");
				},
			}).result();
			if (!payload) throw new Error("Expected payload capture");
			return payload;
		}

		it("sends the profile's effort and output cap on an adaptive model", async () => {
			const payload = await captureSimple(model, { ...ccWire, effort: "xhigh", maxTokens: 64000 });

			expect(payload.output_config).toEqual({ effort: "xhigh" });
			expect(payload.max_tokens).toBe(64000);
			expect(payload.thinking?.display).toBe("omitted");
		});

		it("sends the default effort of the model unless a chosen level or --effort says otherwise", async () => {
			const defaulted = { ...ccWire, effort: undefined, defaultEffort: "high" as const };

			expect((await captureSimple(model, defaulted)).output_config).toEqual({ effort: "high" });
			expect((await captureSimple(model, { ...defaulted, levelChosen: true })).output_config).toEqual({
				effort: "medium",
			});
		});

		it("keeps pi's thinking budget for a budget model whose level the operator chose", async () => {
			const legacy: Model<"anthropic-messages"> = { ...model, compat: {}, maxTokens: 64000 };
			const payload = await captureSimple(legacy, {
				...ccWire,
				effort: undefined,
				levelChosen: true,
				maxTokens: 32000,
			});

			expect(payload.thinking).toMatchObject({ type: "enabled", budget_tokens: 8192, display: "omitted" });
		});

		it("gives a model without adaptive thinking a budget of one token under the cap and no effort", async () => {
			const legacy: Model<"anthropic-messages"> = { ...model, compat: {}, maxTokens: 64000 };
			const payload = await captureSimple(legacy, { ...ccWire, maxTokens: 32000 });

			expect(payload.max_tokens).toBe(32000);
			expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 31999, display: "omitted" });
			expect(payload.output_config).toBeUndefined();
		});
	});
});
