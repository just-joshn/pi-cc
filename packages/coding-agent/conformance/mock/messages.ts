/**
 * A local Anthropic Messages server. It replays one scripted turn per request, records every request
 * it receives to `requests.jsonl`, and answers 502 once the script is exhausted so a side that asks
 * for one turn too many fails on a recorded request rather than a connection error.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import type { IncomingHttpHeaders, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Turn } from "../case.ts";

export interface RecordedRequest {
	index: number;
	path: string;
	method: string;
	headers: IncomingHttpHeaders;
	body: unknown;
}

export interface MockServer {
	port: number;
	requests: RecordedRequest[];
	close(): Promise<void>;
}

export async function startMockServer(options: { turns: Turn[]; outDir: string }): Promise<MockServer> {
	mkdirSync(options.outDir, { recursive: true });
	const logPath = join(options.outDir, "requests.jsonl");
	const requests: RecordedRequest[] = [];
	let turnIndex = 0;
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			const path = request.url ?? "/";
			if (path === "/healthz") {
				response.writeHead(200, { "content-type": "text/plain" }).end("ok");
				return;
			}
			const record: RecordedRequest = {
				index: requests.length,
				path,
				method: request.method ?? "GET",
				headers: request.headers,
				body: parseBody(text),
			};
			requests.push(record);
			appendFileSync(logPath, `${JSON.stringify(record)}\n`);
			if (path.startsWith("/v1/messages/count_tokens")) {
				const body = { input_tokens: Math.ceil(text.length / 4) };
				response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
				return;
			}
			if (!path.startsWith("/v1/messages")) {
				response.writeHead(404, { "content-type": "application/json" }).end('{"error":"unrouted"}');
				return;
			}
			const turn = options.turns[turnIndex];
			if (turn === undefined) {
				response.writeHead(502, { "content-type": "application/json" }).end('{"error":"script exhausted"}');
				return;
			}
			writeTurn(response, turn, turnIndex);
			turnIndex += 1;
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return { port, requests, close: () => closeServer(server) };
}

function parseBody(text: string): unknown {
	if (text.length === 0) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function closeServer(server: Server): Promise<void> {
	server.closeAllConnections();
	return new Promise((resolve) => server.close(() => resolve()));
}

function writeTurn(response: ServerResponse, turn: Turn, turnIndex: number): void {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	const send = (event: string, data: unknown) => {
		response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	};
	if ("sse" in turn) {
		for (const frame of turn.sse) {
			const object = frame as { type?: unknown };
			send(typeof object.type === "string" ? object.type : "message", frame);
		}
		response.end();
		return;
	}
	const blocks = "tool_uses" in turn ? turn.tool_uses : "tool_use" in turn ? [turn.tool_use] : null;
	send("message_start", {
		type: "message_start",
		message: {
			id: `msg_conformance_${turnIndex}`,
			type: "message",
			role: "assistant",
			model: "claude-haiku-4-5",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 12, output_tokens: 0 },
		},
	});
	if (blocks === null) {
		const text = "text" in turn ? turn.text : "";
		send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
		send("content_block_stop", { type: "content_block_stop", index: 0 });
	} else {
		blocks.forEach((block, index) => {
			send("content_block_start", {
				type: "content_block_start",
				index,
				content_block: {
					type: "tool_use",
					id: `toolu_conformance_${turnIndex}_${index}`,
					name: block.name,
					input: {},
				},
			});
			const json = JSON.stringify(block.input ?? {});
			for (const chunk of splitJson(json)) {
				send("content_block_delta", {
					type: "content_block_delta",
					index,
					delta: { type: "input_json_delta", partial_json: chunk },
				});
			}
			send("content_block_stop", { type: "content_block_stop", index });
		});
	}
	send("message_delta", {
		type: "message_delta",
		delta: { stop_reason: blocks === null ? "end_turn" : "tool_use", stop_sequence: null },
		usage: { output_tokens: 8 },
	});
	send("message_stop", { type: "message_stop" });
	response.end();
}

/** Tool arguments arrive in pieces, so the client's accumulator is exercised rather than assumed. */
function splitJson(json: string): string[] {
	if (json.length < 3) return [json];
	const first = Math.floor(json.length / 2);
	return [json.slice(0, first), json.slice(first)];
}
