import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { createOtelExtension } from "../src/core/telemetry/otel-extension.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Received {
	path: string;
	body: {
		resourceMetrics?: {
			scopeMetrics: {
				scope: { name: string };
				metrics: {
					name: string;
					sum: {
						dataPoints: { asDouble: number; attributes: { key: string; value: Record<string, unknown> }[] }[];
					};
				}[];
			}[];
		}[];
		resourceLogs?: {
			scopeLogs: {
				scope: { name: string };
				logRecords: {
					body: { stringValue: string };
					attributes: { key: string; value: Record<string, unknown> }[];
				}[];
			}[];
		}[];
	};
}

const servers: { close: () => Promise<void> }[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function collector() {
	const received: Received[] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			received.push({ path: request.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString()) });
			response.writeHead(200).end("{}");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	servers.push({
		close: () => {
			server.closeAllConnections();
			return new Promise<void>((resolve) => server.close(() => resolve()));
		},
	});
	return { received, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function load(env: Record<string, string>) {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (name: string, handler: Handler) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	createOtelExtension(env)(pi);
	const ctx = { hasUI: false, sessionManager: { getSessionId: () => "session-1" } };
	const emit = async (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	return { emit, subscribed: handlers.size };
}

const assistant = (overrides: Record<string, unknown> = {}) => ({
	role: "assistant",
	model: "requested-model",
	responseModel: "reported-model",
	stopReason: "stop",
	content: [{ type: "text", text: "the reply" }],
	usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.002 } },
	...overrides,
});

async function session(env: Record<string, string>, drive: (emit: ReturnType<typeof load>["emit"]) => Promise<void>) {
	const { received, url } = await collector();
	const { emit } = load({
		CLAUDE_CODE_ENABLE_TELEMETRY: "1",
		OTEL_METRICS_EXPORTER: "otlp",
		OTEL_LOGS_EXPORTER: "otlp",
		OTEL_EXPORTER_OTLP_ENDPOINT: url,
		...env,
	});
	await emit("session_start", { reason: "startup" });
	await drive(emit);
	await emit("session_shutdown", { reason: "quit" });
	const metrics = received.filter((r) => r.path === "/v1/metrics").flatMap((r) => r.body.resourceMetrics ?? []);
	const logs = received.filter((r) => r.path === "/v1/logs").flatMap((r) => r.body.resourceLogs ?? []);
	const points = metrics.flatMap((m) => m.scopeMetrics).flatMap((s) => s.metrics);
	const records = logs.flatMap((l) => l.scopeLogs).flatMap((s) => s.logRecords);
	const attr = (attributes: { key: string; value: Record<string, unknown> }[], key: string) =>
		Object.values(attributes.find((a) => a.key === key)?.value ?? {})[0];
	return {
		received,
		points,
		records,
		attr,
		scopes: [
			...metrics.flatMap((m) => m.scopeMetrics).map((s) => s.scope.name),
			...logs.flatMap((l) => l.scopeLogs).map((s) => s.scope.name),
		],
	};
}

const turn = async (emit: ReturnType<typeof load>["emit"]) => {
	await emit("input", { text: "secret prompt", source: "interactive" });
	await emit("agent_start");
	await emit("message_start", { message: assistant() });
	await emit("message_end", { message: assistant() });
	await emit("agent_end", { messages: [] });
};

describe("otel extension", () => {
	it("subscribes to nothing when export is off", () => {
		expect(load({ OTEL_METRICS_EXPORTER: "otlp" }).subscribed).toBe(0);
		expect(load({ CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_METRICS_EXPORTER: "otlp" }).subscribed).toBeGreaterThan(0);
	});

	it("exports Claude Code's metric names with token, cost and session attributes", async () => {
		const { points, attr } = await session({}, turn);
		const names = points.map((p) => p.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"claude_code.session.count",
				"claude_code.token.usage",
				"claude_code.cost.usage",
				"claude_code.active_time.total",
			]),
		);
		const tokens = points.find((p) => p.name === "claude_code.token.usage")?.sum.dataPoints ?? [];
		expect(tokens.map((p) => [attr(p.attributes, "type"), p.asDouble])).toEqual([
			["input", 10],
			["output", 5],
			["cacheRead", 2],
			["cacheCreation", 1],
		]);
		expect(attr(tokens[0]?.attributes ?? [], "model")).toBe("requested-model");
		expect(attr(tokens[0]?.attributes ?? [], "session.id")).toBe("session-1");
		expect(points.find((p) => p.name === "claude_code.cost.usage")?.sum.dataPoints[0]?.asDouble).toBe(0.002);
	});

	it("names no Anthropic scope", async () => {
		const { scopes } = await session({}, turn);
		expect(scopes.length).toBeGreaterThan(0);
		expect(scopes.join(" ")).not.toMatch(/anthropic/i);
	});

	it("emits user_prompt, api_request and assistant_response events with the content redacted", async () => {
		const { records, attr } = await session({}, turn);
		expect(records.map((r) => r.body.stringValue)).toEqual([
			"claude_code.user_prompt",
			"claude_code.api_request",
			"claude_code.assistant_response",
		]);
		const [prompt, request, response] = records;
		expect(attr(prompt?.attributes ?? [], "prompt")).toBe("<REDACTED>");
		expect(attr(prompt?.attributes ?? [], "prompt_length")).toBe("13");
		expect(attr(request?.attributes ?? [], "model")).toBe("reported-model");
		expect(attr(request?.attributes ?? [], "cost_usd_micros")).toBe(2000);
		expect(attr(response?.attributes ?? [], "response")).toBe("<REDACTED>");
		expect(attr(response?.attributes ?? [], "response_length")).toBe(9);
		expect(records.map((r) => attr(r.attributes, "event.sequence"))).toEqual([0, 1, 2]);
		expect(attr(prompt?.attributes ?? [], "prompt.id")).toBe(attr(request?.attributes ?? [], "prompt.id"));
	});

	it("shows the prompt and the reply once OTEL_LOG_USER_PROMPTS is on", async () => {
		const { records, attr } = await session({ OTEL_LOG_USER_PROMPTS: "1" }, turn);
		expect(attr(records[0]?.attributes ?? [], "prompt")).toBe("secret prompt");
		expect(attr(records[2]?.attributes ?? [], "response")).toBe("the reply");
	});

	it("shows only the reply when only OTEL_LOG_ASSISTANT_RESPONSES is on", async () => {
		const { records, attr } = await session({ OTEL_LOG_ASSISTANT_RESPONSES: "1" }, turn);
		expect(attr(records[0]?.attributes ?? [], "prompt")).toBe("<REDACTED>");
		expect(attr(records[2]?.attributes ?? [], "response")).toBe("the reply");
	});

	it("reports a failed reply as api_error and counts consecutive attempts", async () => {
		const { records, attr } = await session({}, async (emit) => {
			await emit("message_end", { message: assistant({ stopReason: "error", errorMessage: "boom" }) });
			await emit("message_end", { message: assistant({ stopReason: "error", errorMessage: "boom" }) });
		});
		expect(records.map((r) => r.body.stringValue)).toEqual(["claude_code.api_error", "claude_code.api_error"]);
		expect(records.map((r) => attr(r.attributes, "attempt"))).toEqual([1, 2]);
		expect(attr(records[0]?.attributes ?? [], "error")).toBe("boom");
	});

	const toolRun = (
		env: Record<string, string>,
		name = "Bash",
		input: Record<string, unknown> = { command: "git commit -m x", description: "commit" },
	) =>
		session(env, async (emit) => {
			await emit("tool_call", { toolCallId: "t1", toolName: name, input });
			await emit("tool_execution_end", {
				toolCallId: "t1",
				toolName: name,
				isError: false,
				durationMs: 12,
				result: {},
			});
		});

	it("emits tool_decision and tool_result with the input size and no content by default", async () => {
		const { records, attr } = await toolRun({});
		expect(records.map((r) => r.body.stringValue)).toEqual(["claude_code.tool_decision", "claude_code.tool_result"]);
		const [decision, result] = records;
		expect(attr(decision?.attributes ?? [], "decision")).toBe("accept");
		expect(attr(result?.attributes ?? [], "success")).toBe("true");
		expect(attr(result?.attributes ?? [], "tool_input_size_bytes")).toBe(
			JSON.stringify({ command: "git commit -m x", description: "commit" }).length,
		);
		for (const record of records) {
			expect(record.attributes.map((a) => a.key)).not.toContain("tool_parameters");
			expect(record.attributes.map((a) => a.key)).not.toContain("tool_input");
		}
	});

	it("adds tool_parameters and tool_input under OTEL_LOG_TOOL_DETAILS only", async () => {
		const details = await toolRun({ OTEL_LOG_TOOL_DETAILS: "1" });
		expect(details.attr(details.records[0]?.attributes ?? [], "tool_parameters")).toBe(
			JSON.stringify({ bash_command: "git", full_command: "git commit -m x", description: "commit" }),
		);
		expect(details.attr(details.records[1]?.attributes ?? [], "tool_input")).toContain("git commit -m x");
		const content = await toolRun({ OTEL_LOG_TOOL_CONTENT: "1" });
		expect(content.records.flatMap((r) => r.attributes.map((a) => a.key))).not.toContain("tool_input");
	});

	it("counts a commit and added and removed lines from successful tool calls", async () => {
		const commit = await toolRun({});
		expect(commit.points.map((p) => p.name)).toContain("claude_code.commit.count");
		const edit = await toolRun({}, "edit", { file_path: "/w/a.ts", old_string: "a\nb", new_string: "c" });
		const lines = edit.points.find((p) => p.name === "claude_code.lines_of_code.count")?.sum.dataPoints ?? [];
		expect(lines.map((p) => [edit.attr(p.attributes, "type"), p.asDouble])).toEqual([
			["added", 1],
			["removed", 2],
		]);
		const decision = edit.points.find((p) => p.name === "claude_code.code_edit_tool.decision")?.sum.dataPoints[0];
		expect(edit.attr(decision?.attributes ?? [], "language")).toBe("TypeScript");
	});

	it("reports a call that never ran as a rejected decision with no result", async () => {
		const { records, attr } = await session({}, async (emit) => {
			await emit("tool_call", {
				toolCallId: "t1",
				toolName: "write",
				input: { file_path: "/w/a.txt", content: "x" },
			});
			await emit("tool_execution_end", { toolCallId: "t1", toolName: "write", isError: true, result: {} });
		});
		expect(records.map((r) => r.body.stringValue)).toEqual(["claude_code.tool_decision"]);
		expect(attr(records[0]?.attributes ?? [], "decision")).toBe("reject");
	});

	it("drops the session id and adds the version to metrics on request", async () => {
		const { points, attr } = await session(
			{ OTEL_METRICS_INCLUDE_SESSION_ID: "false", OTEL_METRICS_INCLUDE_VERSION: "true" },
			turn,
		);
		const attributes = points.flatMap((p) => p.sum.dataPoints).flatMap((p) => p.attributes);
		expect(attributes.map((a) => a.key)).not.toContain("session.id");
		expect(attributes.map((a) => a.key)).toContain("app.version");
		expect(attr(attributes, "terminal.type")).toBeDefined();
	});

	it("survives a collector that is down", async () => {
		const { emit } = load({
			CLAUDE_CODE_ENABLE_TELEMETRY: "1",
			OTEL_METRICS_EXPORTER: "otlp",
			OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
		});
		await emit("session_start", { reason: "startup" });
		await expect(emit("session_shutdown", { reason: "quit" })).resolves.toBeUndefined();
	});
});
