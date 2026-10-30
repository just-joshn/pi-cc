/** Reads Claude Code stream-json input lines and writes frames. It knows the wire, not the session. */

import type { ImageContent } from "@earendil-works/pi-ai";
import type { ControlRequestBody, Json, SdkFrame, SdkInput } from "./frames.ts";

/** One stdin line as the host acts on it. A line that is not JSON, or a user message that is not from the user, is `invalid` and fatal. */
export function parseInputLine(line: string): SdkInput {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return {
			kind: "invalid",
			message: `Error parsing streaming input line (type=unknown, ${line.length} chars): SyntaxError`,
		};
	}
	if (!isRecord(parsed)) return { kind: "ignored" };
	if (parsed.type === "user") return parseUser(parsed);
	if (parsed.type === "control_request" && isRecord(parsed.request)) {
		return {
			kind: "control",
			requestId: typeof parsed.request_id === "string" ? parsed.request_id : undefined,
			request: parsed.request as ControlRequestBody,
		};
	}
	// keep_alive, update_environment_variables, control_response (a can_use_tool answer: P04) and unknown types.
	return { kind: "ignored" };
}

function parseUser(record: Json): SdkInput {
	const message = record.message;
	const role = isRecord(message) ? message.role : undefined;
	if (!isRecord(message) || role !== "user") {
		return { kind: "invalid", message: `Error: Expected message role 'user', got '${String(role)}'` };
	}
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
