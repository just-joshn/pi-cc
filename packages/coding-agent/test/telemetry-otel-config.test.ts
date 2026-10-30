import { describe, expect, it } from "vitest";
import { otelConfig, parseKeyValues } from "../src/core/telemetry/config.ts";

const ON = { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_METRICS_EXPORTER: "otlp", OTEL_LOGS_EXPORTER: "otlp" };

describe("otelConfig", () => {
	it("is off unless CLAUDE_CODE_ENABLE_TELEMETRY is on", () => {
		expect(otelConfig({ OTEL_METRICS_EXPORTER: "otlp" })).toBeUndefined();
		expect(otelConfig({ CLAUDE_CODE_ENABLE_TELEMETRY: "0", OTEL_METRICS_EXPORTER: "otlp" })).toBeUndefined();
	});

	it("is off without an OTLP exporter", () => {
		expect(otelConfig({ CLAUDE_CODE_ENABLE_TELEMETRY: "1" })).toBeUndefined();
		expect(
			otelConfig({ CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_METRICS_EXPORTER: "console,prometheus" }),
		).toBeUndefined();
	});

	it("is not switched on by the reporting gates being unset or set", () => {
		expect(otelConfig({ ...ON, DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" })).toBeDefined();
	});

	it("defaults to http/json on localhost with the Claude Code intervals", () => {
		const config = otelConfig(ON);
		expect(config?.metrics).toEqual({ protocol: "http/json", url: "http://localhost:4318/v1/metrics", headers: {} });
		expect(config?.logs?.url).toBe("http://localhost:4318/v1/logs");
		expect(config?.metricIntervalMs).toBe(60_000);
		expect(config?.logIntervalMs).toBe(5_000);
		expect(config?.cumulative).toBe(false);
		expect(config?.includeSessionId).toBe(true);
		expect(config?.includeVersion).toBe(false);
	});

	it("takes the endpoint, protocol and headers per signal over the shared ones", () => {
		const config = otelConfig({
			...ON,
			OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/",
			OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
			OTEL_EXPORTER_OTLP_HEADERS: "a=1,b=2",
			OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://logs.example/custom",
			OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
			OTEL_EXPORTER_OTLP_LOGS_HEADERS: "b=3",
		});
		expect(config?.metrics).toEqual({
			protocol: "http/protobuf",
			url: "http://collector:4318/v1/metrics",
			headers: { a: "1", b: "2" },
		});
		expect(config?.logs).toEqual({
			protocol: "http/json",
			url: "http://logs.example/custom",
			headers: { a: "1", b: "3" },
		});
	});

	it("leaves a signal without an exporter when its protocol is grpc", () => {
		const config = otelConfig({ ...ON, OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "grpc" });
		expect(config?.metrics).toBeUndefined();
		expect(config?.logs).toBeDefined();
	});

	it("reads cumulative temporality, include flags and content classes", () => {
		const config = otelConfig({
			...ON,
			OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "Cumulative",
			OTEL_METRICS_INCLUDE_SESSION_ID: "false",
			OTEL_METRICS_INCLUDE_VERSION: "true",
			OTEL_LOG_USER_PROMPTS: "1",
			OTEL_LOG_TOOL_DETAILS: "true",
		});
		expect(config?.cumulative).toBe(true);
		expect(config?.includeSessionId).toBe(false);
		expect(config?.includeVersion).toBe(true);
		expect(config?.content).toEqual({
			userPrompts: true,
			assistantResponses: false,
			toolContent: false,
			toolDetails: true,
		});
	});
});

describe("parseKeyValues", () => {
	it("splits pairs, decodes values and drops malformed ones", () => {
		expect(parseKeyValues("a=1, b=x%20y,=bad,novalue,c=%E0%A4%A,d=a=b")).toEqual({ a: "1", b: "x y", d: "a=b" });
		expect(parseKeyValues(undefined)).toEqual({});
	});
});
