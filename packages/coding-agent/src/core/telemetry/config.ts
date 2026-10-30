/**
 * The operator's OpenTelemetry export, read from `CLAUDE_CODE_ENABLE_TELEMETRY` and `OTEL_*`. Settings
 * `env` entries reach this through `process.env`, because the CLI applies them there before extensions load.
 * OTLP over http/json and http/protobuf is exported. Other protocols (grpc) and exporters (console,
 * prometheus) leave that signal without an exporter, as does a missing endpoint, which defaults to localhost.
 */

import { type ContentLogging, contentLogging } from "./content-logging.ts";

type Env = Readonly<Record<string, string | undefined>>;

export type OtlpProtocol = "http/json" | "http/protobuf";
export type Signal = "metrics" | "logs";

export interface OtlpTarget {
	readonly protocol: OtlpProtocol;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
}

export interface OtelConfig {
	readonly metrics: OtlpTarget | undefined;
	readonly logs: OtlpTarget | undefined;
	readonly resource: Readonly<Record<string, string>>;
	readonly metricIntervalMs: number;
	readonly logIntervalMs: number;
	/** Metric temporality: delta unless the operator asks for cumulative. */
	readonly cumulative: boolean;
	readonly includeSessionId: boolean;
	readonly includeVersion: boolean;
	readonly content: ContentLogging;
}

const PROTOCOLS: readonly string[] = ["http/json", "http/protobuf"];

const isOn = (value: string | undefined): boolean =>
	["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");

/** `k=v,k2=v2` as in `OTEL_EXPORTER_OTLP_HEADERS`. Values are URL-decoded and malformed pairs are dropped. */
export function parseKeyValues(value: string | undefined): Record<string, string> {
	const entries: [string, string][] = [];
	for (const pair of (value ?? "").split(",")) {
		const at = pair.indexOf("=");
		const key = pair.slice(0, at).trim();
		if (at < 1 || key === "") continue;
		try {
			entries.push([key, decodeURIComponent(pair.slice(at + 1).trim())]);
		} catch {
			// A value with a bad percent escape is a malformed pair.
		}
	}
	return Object.fromEntries(entries);
}

function target(env: Env, signal: Signal): OtlpTarget | undefined {
	const exporters = (env[`OTEL_${signal.toUpperCase()}_EXPORTER`] ?? "").split(",").map((name) => name.trim());
	if (!exporters.includes("otlp")) return undefined;
	const upper = signal.toUpperCase();
	const protocol =
		env[`OTEL_EXPORTER_OTLP_${upper}_PROTOCOL`]?.trim() || env.OTEL_EXPORTER_OTLP_PROTOCOL?.trim() || "http/json";
	if (!PROTOCOLS.includes(protocol)) return undefined;
	const specific = env[`OTEL_EXPORTER_OTLP_${upper}_ENDPOINT`]?.trim();
	const base = (env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || "http://localhost:4318").replace(/\/+$/, "");
	return {
		protocol: protocol as OtlpProtocol,
		url: specific || `${base}/v1/${signal}`,
		headers: {
			...parseKeyValues(env.OTEL_EXPORTER_OTLP_HEADERS),
			...parseKeyValues(env[`OTEL_EXPORTER_OTLP_${upper}_HEADERS`]),
		},
	};
}

const positive = (value: string | undefined, fallback: number): number => {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Undefined unless `CLAUDE_CODE_ENABLE_TELEMETRY` is on and a signal has a usable OTLP exporter. */
export function otelConfig(env: Env): OtelConfig | undefined {
	if (!isOn(env.CLAUDE_CODE_ENABLE_TELEMETRY)) return undefined;
	const metrics = target(env, "metrics");
	const logs = target(env, "logs");
	if (metrics === undefined && logs === undefined) return undefined;
	return {
		metrics,
		logs,
		resource: parseKeyValues(env.OTEL_RESOURCE_ATTRIBUTES),
		metricIntervalMs: positive(env.OTEL_METRIC_EXPORT_INTERVAL, 60_000),
		logIntervalMs: positive(env.OTEL_LOGS_EXPORT_INTERVAL, 5_000),
		cumulative: env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE?.trim().toLowerCase() === "cumulative",
		includeSessionId: env.OTEL_METRICS_INCLUDE_SESSION_ID === undefined || isOn(env.OTEL_METRICS_INCLUDE_SESSION_ID),
		includeVersion: isOn(env.OTEL_METRICS_INCLUDE_VERSION),
		content: contentLogging(env),
	};
}
