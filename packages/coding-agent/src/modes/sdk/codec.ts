/** Reads Claude Code stream-json input lines and writes frames. It knows the wire, not the session. */

import type { ImageContent } from "@earendil-works/pi-ai";
import type { ControlRequestBody, Json, SdkFrame, SdkInput } from "./frames.ts";

/** One stdin line as the host acts on it. A line that is not JSON is `invalid`, the only fatal case. */
export function parseInputLine(line: string): SdkInput {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return { kind: "invalid", characters: line.length };
	}
	if (!isRecord(parsed)) return { kind: "ignored" };
	if (parsed.type === "user") return parseUser(parsed);
	if (parsed.type === "control_request" && isRecord(parsed.request) && typeof parsed.request.subtype === "string") {
		return {
			kind: "control",
			requestId: typeof parsed.request_id === "string" ? parsed.request_id : undefined,
			request: parsed.request as ControlRequestBody,
		};
	}
	// keep_alive, update_environment_variables, control_response (a can_use_tool answer: P04) and unknown types.
	return { kind: "ignored" };
}

/** The error Claude Code prints for a stdin line that is not JSON, then exits 1 (measured). */
export function invalidLineMessage(characters: number): string {
	return `Error parsing streaming input line (type=unknown, ${characters} chars): SyntaxError`;
}

function parseUser(record: Json): SdkInput {
	const message = record.message;
	if (!isRecord(message)) return { kind: "ignored" };
	const content = message.content;
	if (typeof content === "string") return { kind: "user", content, text: content, images: [] };
	if (!Array.isArray(content)) return { kind: "ignored" };
	const blocks = content.filter(isRecord);
	const text = blocks
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
	return { kind: "user", content: blocks, text, images: blocks.flatMap(imageOf) };
}

function imageOf(block: Json): ImageContent[] {
	const source = block.source;
	if (block.type !== "image" || !isRecord(source) || source.type !== "base64") return [];
	if (typeof source.data !== "string" || typeof source.media_type !== "string") return [];
	return [{ type: "image", data: source.data, mimeType: source.media_type }];
}

/** A frame as one stdout line. */
export function encodeFrame(frame: SdkFrame): string {
	return `${JSON.stringify(frame)}\n`;
}

function isRecord(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
