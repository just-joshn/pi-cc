import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { logsBody, metricsBody } from "../src/core/telemetry/otlp.ts";
import { encodeLogs, encodeMetrics } from "../src/core/telemetry/otlp-protobuf.ts";
import { sendOtlp } from "../src/core/telemetry/otlp-transport.ts";

const SCOPE = { name: "pi-cc.claude_code", version: "1.0.0" };

interface Field {
	no: number;
	bytes?: Buffer;
	varint?: bigint;
	fixed64?: Buffer;
}

/** A minimal protobuf wire reader, enough to read the encoder's output back. */
function readFields(buffer: Buffer): Field[] {
	const fields: Field[] = [];
	let at = 0;
	const readVarint = (): bigint => {
		let value = 0n;
		let shift = 0n;
		for (;;) {
			const byte = buffer[at++];
			value |= BigInt(byte & 0x7f) << shift;
			if ((byte & 0x80) === 0) return value;
			shift += 7n;
		}
	};
	while (at < buffer.length) {
		const key = Number(readVarint());
		const no = key >> 3;
		const wire = key & 7;
		if (wire === 0) fields.push({ no, varint: readVarint() });
		else if (wire === 1) {
			fields.push({ no, fixed64: buffer.subarray(at, at + 8) });
			at += 8;
		} else {
			const length = Number(readVarint());
			fields.push({ no, bytes: buffer.subarray(at, at + length) });
			at += length;
		}
	}
	return fields;
}

const first = (fields: Field[], no: number): Field | undefined => fields.find((field) => field.no === no);

describe("OTLP bodies", () => {
	it("build a delta sum metric with typed attributes", () => {
		const body = metricsBody(
			{ "service.name": "claude-code" },
			SCOPE,
			[
				{
					name: "claude_code.token.usage",
					unit: "tokens",
					attributes: { type: "input", n: 3, ok: true, f: 0.5 },
					value: 12,
				},
			],
			1000,
			2000,
			1,
		);
		const metric = body.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0];
		expect(metric?.name).toBe("claude_code.token.usage");
		expect(metric?.sum).toMatchObject({ aggregationTemporality: 1, isMonotonic: true });
		expect(metric?.sum.dataPoints[0]).toMatchObject({
			asDouble: 12,
			startTimeUnixNano: "1000000000",
			timeUnixNano: "2000000000",
		});
		expect(metric?.sum.dataPoints[0]?.attributes).toEqual([
			{ key: "type", value: { stringValue: "input" } },
			{ key: "n", value: { intValue: 3 } },
			{ key: "ok", value: { boolValue: true } },
			{ key: "f", value: { doubleValue: 0.5 } },
		]);
	});

	it("build log records whose body is the claude_code-prefixed event name", () => {
		const body = logsBody({}, SCOPE, [
			{ name: "user_prompt", timeMs: 5, attributes: { "event.name": "user_prompt" } },
		]);
		expect(body.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.body).toEqual({
			stringValue: "claude_code.user_prompt",
		});
	});
});

describe("OTLP protobuf encoding", () => {
	it("round-trips a metrics request through the collector v1 field numbers", () => {
		const json = metricsBody(
			{ "service.name": "claude-code" },
			SCOPE,
			[{ name: "claude_code.cost.usage", unit: "USD", attributes: { model: "m" }, value: 0.25 }],
			1000,
			2000,
			2,
		);
		const request = readFields(Buffer.from(encodeMetrics(json)));
		const resourceMetrics = readFields(first(request, 1)?.bytes ?? Buffer.alloc(0));
		const scopeMetrics = readFields(first(resourceMetrics, 2)?.bytes ?? Buffer.alloc(0));
		const metric = readFields(first(scopeMetrics, 2)?.bytes ?? Buffer.alloc(0));
		expect(first(metric, 1)?.bytes?.toString()).toBe("claude_code.cost.usage");
		expect(first(metric, 3)?.bytes?.toString()).toBe("USD");
		const sum = readFields(first(metric, 7)?.bytes ?? Buffer.alloc(0));
		expect(first(sum, 2)?.varint).toBe(2n);
		expect(first(sum, 3)?.varint).toBe(1n);
		const point = readFields(first(sum, 1)?.bytes ?? Buffer.alloc(0));
		expect(first(point, 4)?.fixed64?.readDoubleLE()).toBe(0.25);
		expect(first(point, 3)?.fixed64?.readBigUInt64LE()).toBe(2_000_000_000n);
	});

	it("round-trips a logs request", () => {
		const json = logsBody({}, SCOPE, [{ name: "api_request", timeMs: 7, attributes: { input_tokens: 12 } }]);
		const request = readFields(Buffer.from(encodeLogs(json)));
		const resourceLogs = readFields(first(request, 1)?.bytes ?? Buffer.alloc(0));
		const scopeLogs = readFields(first(resourceLogs, 2)?.bytes ?? Buffer.alloc(0));
		const record = readFields(first(scopeLogs, 2)?.bytes ?? Buffer.alloc(0));
		const body = readFields(first(record, 5)?.bytes ?? Buffer.alloc(0));
		expect(first(body, 1)?.bytes?.toString()).toBe("claude_code.api_request");
		const attribute = readFields(first(record, 6)?.bytes ?? Buffer.alloc(0));
		expect(first(attribute, 1)?.bytes?.toString()).toBe("input_tokens");
		const value = readFields(first(attribute, 2)?.bytes ?? Buffer.alloc(0));
		expect(first(value, 3)?.varint).toBe(12n);
	});
});

describe("sendOtlp", () => {
	async function receive(status: number, run: (url: string) => Promise<void>) {
		const seen: { headers: IncomingHttpHeaders; body: Buffer }[] = [];
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				seen.push({ headers: request.headers, body: Buffer.concat(chunks) });
				response.writeHead(status).end("{}");
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/logs`);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		return seen;
	}

	const body = {
		signal: "logs" as const,
		json: logsBody({}, SCOPE, [{ name: "user_prompt", timeMs: 1, attributes: {} }]),
	};

	it("posts JSON with the operator's headers", async () => {
		const seen = await receive(200, (url) =>
			sendOtlp({ protocol: "http/json", url, headers: { "x-probe": "abc" } }, body),
		);
		expect(seen[0]?.headers["content-type"]).toBe("application/json");
		expect(seen[0]?.headers["x-probe"]).toBe("abc");
		expect(JSON.parse(seen[0]?.body.toString() ?? "")).toEqual(body.json);
	});

	it("posts protobuf", async () => {
		const seen = await receive(200, (url) => sendOtlp({ protocol: "http/protobuf", url, headers: {} }, body));
		expect(seen[0]?.headers["content-type"]).toBe("application/x-protobuf");
		expect(seen[0]?.body.equals(Buffer.from(encodeLogs(body.json)))).toBe(true);
	});

	it("rejects on a non-2xx answer", async () => {
		await receive(500, async (url) => {
			await expect(sendOtlp({ protocol: "http/json", url, headers: {} }, body)).rejects.toThrow("HTTP 500");
		});
	});
});
