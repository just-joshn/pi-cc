import { describe, expect, it } from "vitest";
import { capAnthropicMedia } from "../src/api/anthropic-media.ts";
import type { AnthropicContentBlock, AnthropicMessageParam } from "../src/api/anthropic-wire.ts";

const limits = { items: 100, itemBuffer: 20, bytes: 78_643_200, byteBuffer: 10_485_760, documentBytes: 0 };
const image = (data = "AAAA"): AnthropicContentBlock => ({
	type: "image",
	source: { type: "base64", media_type: "image/png", data },
});

describe("Anthropic request media caps", () => {
	it("removes oldest images with hysteresis and a marker when a row becomes empty", () => {
		const messages: AnthropicMessageParam[] = Array.from({ length: 101 }, () => ({
			role: "user",
			content: [image()],
		}));
		const capped = capAnthropicMedia(messages, limits);
		expect(capped.filter((message) => JSON.stringify(message).includes('"image"'))).toHaveLength(80);
		expect(capped[0].content).toEqual([{ type: "text", text: "[media removed: request limit]" }]);
		expect(messages[0].content).toEqual([image()]);
	});
	it("replaces nested documents and images in tool results, preserving text", () => {
		const messages: AnthropicMessageParam[] = [
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "id",
						is_error: false,
						content: [
							image(),
							{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "PDF" } },
							{ type: "text", text: "keep" },
						],
					},
				],
			},
		];
		const capped = capAnthropicMedia(messages, { ...limits, items: 1, itemBuffer: 0 });
		expect(JSON.stringify(capped)).toContain("[media removed: request limit]");
		expect(JSON.stringify(capped)).toContain('"document"');
		expect(JSON.stringify(capped)).toContain("keep");
		expect(JSON.stringify(capped)).not.toContain('"image"');
	});
	it("enforces total and document byte caps independently", () => {
		const messages: AnthropicMessageParam[] = [{ role: "user", content: [image("123456"), image("789012")] }];
		const capped = capAnthropicMedia(messages, { ...limits, bytes: 10, byteBuffer: 2 });
		expect(capped[0].content).toEqual([image("789012")]);
		const docs: AnthropicMessageParam[] = [
			{
				role: "user",
				content: [
					image(),
					{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "123456" } },
				],
			},
		];
		expect(capAnthropicMedia(docs, { ...limits, documentBytes: 5, byteBuffer: 1 })[0].content).toEqual([image()]);
	});
	it("returns the unmodified request when no cap is reached", () => {
		const messages: AnthropicMessageParam[] = [{ role: "user", content: [image()] }];
		expect(capAnthropicMedia(messages, limits)).toBe(messages);
	});
});
