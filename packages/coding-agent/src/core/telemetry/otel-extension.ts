/**
 * The operator-owned OpenTelemetry export as a built-in extension. It does nothing unless
 * `CLAUDE_CODE_ENABLE_TELEMETRY` and an OTLP exporter are configured, and then sends only to the
 * endpoint the operator named. Metric and event names follow Claude Code 2.1.312's, with the
 * Anthropic-identifying instrumentation scope replaced.
 */

import { createHash, randomUUID } from "node:crypto";
import { arch, hostname, platform, release } from "node:os";
import { extname } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { VERSION } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../extensions/types.ts";
import { type OtelConfig, otelConfig } from "./config.ts";
import { gated } from "./content-logging.ts";
import { type Attributes, type LogEvent, logsBody, metricsBody, type SumPoint } from "./otlp.ts";
import { type OtlpBody, sendOtlp } from "./otlp-transport.ts";

type Env = Readonly<Record<string, string | undefined>>;

const SCOPE = { name: "pi-cc.claude_code", version: VERSION };
const EVENT_SCOPE = { name: "pi-cc.claude_code.events", version: VERSION };
const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit"]);
const LANGUAGES: Readonly<Record<string, string>> = {
	".ts": "TypeScript",
	".tsx": "TypeScript",
	".js": "JavaScript",
	".jsx": "JavaScript",
	".mjs": "JavaScript",
	".cjs": "JavaScript",
	".py": "Python",
	".go": "Go",
	".rs": "Rust",
	".java": "Java",
	".rb": "Ruby",
	".md": "Markdown",
	".json": "JSON",
	".sh": "Shell",
	".css": "CSS",
	".html": "HTML",
	".yml": "YAML",
	".yaml": "YAML",
	".c": "C",
	".cpp": "C++",
	".swift": "Swift",
	".txt": "Plain text",
};
const GIT_COMMIT = /(?:^|[;&|]\s*|\s)git(?:\s+-c\s+\S+)*\s+commit\b/;
const GH_PR_CREATE = /(?:^|[;&|]\s*|\s)gh\s+pr\s+create\b/;

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const lineCount = (text: unknown): number =>
	typeof text === "string" && text !== "" ? text.replace(/\n$/, "").split("\n").length : 0;

/** Everything the exporter holds between flushes: summed points and queued events. */
class Pending {
	points = new Map<string, SumPoint>();
	events: LogEvent[] = [];
	since = Date.now();

	add(name: string, unit: string, attributes: Attributes, value: number): void {
		const key = `${name}\u0000${JSON.stringify(attributes)}`;
		this.points.set(key, { name, unit, attributes, value: (this.points.get(key)?.value ?? 0) + value });
	}
}

/** A stable per-machine identifier that carries no account: the hash of the login and host names. */
const userId = (env: Env): string =>
	createHash("sha256")
		.update(`${env.USER ?? env.LOGNAME ?? ""}@${hostname()}`)
		.digest("hex");

function resourceAttributes(config: OtelConfig): Attributes {
	return {
		...config.resource,
		"host.arch": arch(),
		"os.type": platform(),
		"os.version": release(),
		"service.name": "claude-code",
		"service.version": VERSION,
	};
}

function createExporter(config: OtelConfig, env: Env) {
	const resource = resourceAttributes(config);
	let pending = new Pending();
	let sequence = 0;
	let sessionId = "";
	const terminal = env.TERM_PROGRAM || env.TERM || "unknown";
	const identity = userId(env);

	const metricBase = (): Attributes => ({
		...config.resource,
		"user.id": identity,
		...(config.includeSessionId ? { "session.id": sessionId } : {}),
		...(config.includeVersion ? { "app.version": VERSION } : {}),
		"terminal.type": terminal,
	});

	const deliver = (body: OtlpBody): Promise<void> => {
		const route = body.signal === "metrics" ? config.metrics : config.logs;
		// The collector being down only loses this batch; telemetry never interrupts the session.
		return route === undefined ? Promise.resolve() : sendOtlp(route, body).catch(() => undefined);
	};

	return {
		startSession(id: string): void {
			sessionId = id;
		},
		metric(name: string, unit: string, attributes: Attributes, value: number): void {
			pending.add(name, unit, { ...metricBase(), ...attributes }, value);
		},
		event(name: string, attributes: Attributes): void {
			pending.events.push({
				name,
				timeMs: Date.now(),
				attributes: {
					...config.resource,
					"user.id": identity,
					"session.id": sessionId,
					...(config.includeVersion ? { "app.version": VERSION } : {}),
					"terminal.type": terminal,
					"event.name": name,
					"event.timestamp": new Date().toISOString(),
					"event.sequence": sequence++,
					...attributes,
				},
			});
		},
		flushMetrics(): Promise<void> {
			const { points, since } = pending;
			if (points.size === 0) return Promise.resolve();
			const next = new Pending();
			next.events = pending.events;
			if (config.cumulative) {
				next.points = new Map(points);
				next.since = since;
			}
			pending = next;
			const json = metricsBody(resource, SCOPE, [...points.values()], since, Date.now(), config.cumulative ? 2 : 1);
			return deliver({ signal: "metrics", json });
		},
		flushLogs(): Promise<void> {
			const { events } = pending;
			if (events.length === 0) return Promise.resolve();
			pending.events = [];
			return deliver({ signal: "logs", json: logsBody(resource, EVENT_SCOPE, events) });
		},
	};
}

type Exporter = ReturnType<typeof createExporter>;

function toolParameters(toolName: string, input: Record<string, unknown>): string {
	if (toolName.toLowerCase() === "bash") {
		const command = str(input.command);
		return JSON.stringify({
			bash_command: command.trim().split(/\s+/)[0] ?? "",
			full_command: command,
			...(str(input.description) === "" ? {} : { description: str(input.description) }),
		});
	}
	const path = str(input.file_path) || str(input.path);
	return JSON.stringify(path === "" ? {} : { file_path: path });
}

/** `Edit` counts old text as removed and new text as added. `Write` counts every written line as added, which is inferred, since there is no diff against the old file. */
function linesChanged(toolName: string, input: Record<string, unknown>): { added: number; removed: number } {
	if (toolName === "write") return { added: lineCount(input.content), removed: 0 };
	if (toolName === "edit") return { added: lineCount(input.new_string), removed: lineCount(input.old_string) };
	if (toolName !== "multiedit" || !Array.isArray(input.edits)) return { added: 0, removed: 0 };
	const edits = input.edits as Record<string, unknown>[];
	return {
		added: edits.reduce((total, edit) => total + lineCount(edit.new_string), 0),
		removed: edits.reduce((total, edit) => total + lineCount(edit.old_string), 0),
	};
}

function wireTools(pi: ExtensionAPI, out: Exporter, config: OtelConfig, promptId: () => string): void {
	const calls = new Map<string, Record<string, unknown>>();
	pi.on("tool_call", (event) => {
		calls.set(event.toolCallId, { ...(event.input as Record<string, unknown>) });
	});
	pi.on("tool_execution_end", (event) => {
		const input = calls.get(event.toolCallId) ?? {};
		calls.delete(event.toolCallId);
		const name = event.toolName;
		const lower = name.toLowerCase();
		// A call that never ran has no duration. Pi does not say who blocked it, so it reads as a config rejection (inferred).
		const ran = event.durationMs !== undefined;
		const decision = ran ? "accept" : "reject";
		const details: Attributes = config.content.toolDetails ? { tool_parameters: toolParameters(name, input) } : {};
		out.event("tool_decision", {
			"prompt.id": promptId(),
			decision,
			source: "config",
			tool_name: name,
			tool_use_id: event.toolCallId,
			tool_source: "builtin",
			...details,
		});
		if (EDIT_TOOLS.has(lower)) {
			const language =
				LANGUAGES[extname(str(input.file_path) || str(input.notebook_path)).toLowerCase()] ?? "unknown";
			out.metric(
				"claude_code.code_edit_tool.decision",
				"",
				{ decision, source: "config", tool_name: name, language },
				1,
			);
		}
		if (!ran) return;
		const text = JSON.stringify(input);
		out.event("tool_result", {
			"prompt.id": promptId(),
			tool_name: name,
			tool_use_id: event.toolCallId,
			success: String(!event.isError),
			duration_ms: event.durationMs ?? 0,
			...(event.isError ? { error_type: "Error" } : {}),
			...(event.isError && config.content.toolDetails ? { error: errorText(event.result) } : {}),
			...details,
			...(config.content.toolDetails ? { tool_input: text } : {}),
			tool_input_size_bytes: Buffer.byteLength(text),
		});
		if (event.isError) return;
		const { added, removed } = linesChanged(lower, input);
		if (added > 0) out.metric("claude_code.lines_of_code.count", "", { type: "added" }, added);
		if (removed > 0) out.metric("claude_code.lines_of_code.count", "", { type: "removed" }, removed);
		const command = lower === "bash" ? str(input.command) : "";
		if (GIT_COMMIT.test(command)) out.metric("claude_code.commit.count", "", {}, 1);
		if (GH_PR_CREATE.test(command)) out.metric("claude_code.pull_request.count", "", {}, 1);
	});
}

function errorText(result: unknown): string {
	const content = (result as { content?: { type?: string; text?: string }[] } | undefined)?.content;
	return (content ?? []).map((block) => block.text ?? "").join("\n");
}

function assistantText(message: AssistantMessage): string {
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function wireMessages(pi: ExtensionAPI, out: Exporter, config: OtelConfig, promptId: () => string): void {
	let attempt = 0;
	let started = Date.now();
	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") started = Date.now();
	});
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		const querySource = ctx.hasUI ? "repl_main_thread" : "sdk";
		if (message.stopReason === "error") {
			attempt += 1;
			out.event("api_error", {
				"prompt.id": promptId(),
				model: message.model,
				error: message.errorMessage ?? "unknown error",
				duration_ms: Date.now() - started,
				attempt,
				query_source: querySource,
			});
			return;
		}
		attempt = 0;
		const { usage } = message;
		const cost = usage.cost.total;
		const effort = message.providerThinkingLevel ?? message.thinkingLevel;
		const tokens: [string, number][] = [
			["input", usage.input],
			["output", usage.output],
			["cacheRead", usage.cacheRead],
			["cacheCreation", usage.cacheWrite],
		];
		const shared = { model: message.model, query_source: "main", ...(effort === undefined ? {} : { effort }) };
		for (const [type, count] of tokens) out.metric("claude_code.token.usage", "tokens", { ...shared, type }, count);
		out.metric("claude_code.cost.usage", "USD", shared, cost);
		const reported = message.responseModel ?? message.model;
		out.event("api_request", {
			"prompt.id": promptId(),
			model: reported,
			input_tokens: usage.input,
			output_tokens: usage.output,
			cache_read_tokens: usage.cacheRead,
			cache_creation_tokens: usage.cacheWrite,
			cost_usd: cost,
			cost_usd_micros: Math.round(cost * 1_000_000),
			duration_ms: Date.now() - started,
			speed: "normal",
			query_source: querySource,
			...(effort === undefined ? {} : { effort }),
		});
		if (message.stopReason === "stop") {
			const text = assistantText(message);
			out.event("assistant_response", {
				"prompt.id": promptId(),
				response_length: text.length,
				response: gated(config.content.assistantResponses || config.content.userPrompts, text),
				"message.uuid": randomUUID(),
				model: reported,
				query_source: querySource,
			});
		}
	});
}

function wireSession(pi: ExtensionAPI, out: Exporter, config: OtelConfig): void {
	let promptId = randomUUID();
	let activeSince: number | undefined;
	pi.on("session_start", (event, ctx: ExtensionContext) => {
		out.startSession(ctx.sessionManager.getSessionId());
		out.metric(
			"claude_code.session.count",
			"",
			{ start_type: event.reason === "startup" ? "fresh" : event.reason },
			1,
		);
	});
	pi.on("input", (event) => {
		promptId = randomUUID();
		out.event("user_prompt", {
			"prompt.id": promptId,
			prompt_length: String(event.text.length),
			prompt: gated(config.content.userPrompts, event.text),
			prompt_text: gated(config.content.userPrompts, event.text),
			"message.uuid": randomUUID(),
		});
	});
	pi.on("agent_start", () => {
		activeSince = performance.now();
	});
	pi.on("agent_end", () => {
		if (activeSince === undefined) return;
		out.metric("claude_code.active_time.total", "s", { type: "cli" }, (performance.now() - activeSince) / 1000);
		activeSince = undefined;
	});
	wireMessages(pi, out, config, () => promptId);
	wireTools(pi, out, config, () => promptId);
}

/** Built-in extension: exports Claude Code's metrics and events over OTLP when the operator has turned it on. */
export function createOtelExtension(env: Env = process.env): ExtensionFactory {
	return (pi) => {
		const config = otelConfig(env);
		if (config === undefined) return;
		const out = createExporter(config, env);
		const timers = [
			setInterval(() => void out.flushMetrics(), config.metricIntervalMs),
			setInterval(() => void out.flushLogs(), config.logIntervalMs),
		];
		for (const timer of timers) timer.unref();
		wireSession(pi, out, config);
		// The timers outlive /new and /resume, so shutdown flushes whatever the session left.
		pi.on("session_shutdown", async () => {
			await Promise.all([out.flushMetrics(), out.flushLogs()]);
		});
	};
}

export default createOtelExtension();
