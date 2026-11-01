import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { recordFetch } from "./anthropic-utils.ts";

interface AnthropicToolPayload {
	tools?: Array<{ strict?: boolean; input_schema: Record<string, unknown> }>;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function createModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		api: "anthropic-messages",
		provider: "test-anthropic",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
	};
}

function createTool(parameters: Tool["parameters"], constrainedSampling?: Tool["constrainedSampling"]): Tool {
	return {
		name: "lookup",
		description: "Look up a value",
		parameters,
		...(constrainedSampling === undefined ? {} : { constrainedSampling }),
	};
}

function createStrictTool(parameters: Tool["parameters"]): Tool {
	return createTool(parameters, { type: "json_schema", strict: "prefer" });
}

async function captureFirstTool(tool: Tool): Promise<NonNullable<AnthropicToolPayload["tools"]>[number]> {
	let payload: AnthropicToolPayload | undefined;
	const stream = streamAnthropic(
		createModel(),
		normalizeContext({ messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }], tools: [tool] }),
		{
			apiKey: "test-key",
			cacheRetention: "none",
			onPayload: (value) => {
				payload = value as AnthropicToolPayload;
				throw new PayloadCaptured();
			},
		},
	);
	await stream.result();

	const firstTool = payload?.tools?.[0];
	if (!firstTool) {
		throw new Error("Expected a tool in the captured Anthropic payload");
	}
	return firstTool;
}

describe("Anthropic strict tool schemas", () => {
	it.each([true, false])(
		"preserves explicitly unconstrained schemas on the wire with strict capability %s",
		async (supportsStrictTools) => {
			const parameters = Type.Object(
				{ pattern: Type.String({ description: "Search expression" }), path: Type.Optional(Type.String()) },
				{
					$schema: "https://json-schema.org/draft/2020-12/schema",
					additionalProperties: false,
					title: "SearchInput",
				},
			);
			const definition = { ...createTool(parameters, false), eagerInputStreaming: false };
			const { requests, fetch } = recordFetch(() =>
				Response.json({ error: { type: "invalid_request_error", message: "captured" } }, { status: 400 }),
			);
			await streamAnthropic(
				{ ...createModel(), compat: { supportsStrictTools } },
				normalizeContext({ messages: [{ role: "user", content: "Search", timestamp: 1 }], tools: [definition] }),
				{ apiKey: "test-key", fetch, cacheRetention: "none", maxRetries: 0 },
			).result();
			expect(requests).toHaveLength(1);
			expect(requests[0].body.tools).toEqual([
				{
					name: definition.name,
					description: definition.description,
					input_schema: JSON.parse(JSON.stringify(parameters)),
				},
			]);
		},
	);

	it("keeps schema preservation and eager streaming independent", async () => {
		const parameters = Type.Object({ value: Type.String() }, { additionalProperties: false });
		const { requests, fetch } = recordFetch(() =>
			Response.json({ error: { type: "invalid_request_error", message: "captured" } }, { status: 400 }),
		);
		await streamAnthropic(
			createModel(),
			normalizeContext({
				messages: [{ role: "user", content: "Use the tools", timestamp: 1 }],
				tools: [
					createTool(parameters, false),
					{ ...createTool(parameters), name: "no_stream", eagerInputStreaming: false },
				],
			}),
			{ apiKey: "test-key", fetch, cacheRetention: "none", maxRetries: 0 },
		).result();
		expect(requests[0].body.tools).toEqual([
			{
				name: "lookup",
				description: "Look up a value",
				input_schema: JSON.parse(JSON.stringify(parameters)),
				eager_input_streaming: true,
			},
			{
				name: "no_stream",
				description: "Look up a value",
				input_schema: { type: "object", properties: parameters.properties, required: parameters.required },
			},
		]);
	});

	it("keeps the legacy schema shape unless strict or explicitly unconstrained", async () => {
		const legacyParameters = Type.Object(
			{ value: Type.String() },
			{ additionalProperties: false, title: "LookupInput" },
		);
		const legacyTool = await captureFirstTool(createTool(legacyParameters));
		expect(legacyTool.strict).toBeUndefined();
		expect(legacyTool.input_schema).toEqual({
			type: "object",
			properties: legacyParameters.properties,
			required: legacyParameters.required,
		});

		const strictTool = await captureFirstTool(
			createStrictTool(
				Type.Object(
					{ value: Type.String(), optional: Type.Optional(Type.Number()) },
					{ title: "StrictLookupInput" },
				),
			),
		);
		expect(strictTool.strict).toBe(true);
		expect(strictTool.input_schema).toMatchObject({
			additionalProperties: false,
			required: ["value", "optional"],
			properties: { optional: { anyOf: [{ type: "number" }, { type: "null" }] } },
			title: "StrictLookupInput",
		});
	});

	// https://github.com/earendil-works/pi/issues/9953
	it("sends prefer tools non-strict when they use keywords Anthropic strict mode rejects", async () => {
		const unsupportedParameters: Tool["parameters"][] = [
			Type.Object({ timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 300000 })) }),
			Type.Object({ options: Type.Object({ tags: Type.Array(Type.String(), { minItems: 2 }) }) }),
			Type.Object({ expression: Type.String({ format: "regex" }) }),
		];
		for (const parameters of unsupportedParameters) {
			const tool = await captureFirstTool(createStrictTool(parameters));
			expect(tool.strict).toBeUndefined();
		}

		const supportedTool = await captureFirstTool(
			createStrictTool(
				Type.Object({
					code: Type.String({ minLength: 1, maxLength: 1000, pattern: "^[a-z]+$" }),
					url: Type.String({ format: "uri" }),
					tags: Type.Array(Type.String(), { minItems: 1 }),
				}),
			),
		);
		expect(supportedTool.strict).toBe(true);
	});
});
