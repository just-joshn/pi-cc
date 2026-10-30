/** Delivery of one OTLP body to the operator's collector over http/json or http/protobuf. */

import type { OtlpTarget } from "./config.ts";
import type { LogsBody, MetricsBody } from "./otlp.ts";
import { encodeLogs, encodeMetrics } from "./otlp-protobuf.ts";

export type OtlpBody = { signal: "metrics"; json: MetricsBody } | { signal: "logs"; json: LogsBody };

const TIMEOUT_MS = 10_000;

/** Rejects when the collector is unreachable or answers a non-2xx status. */
export async function sendOtlp(target: OtlpTarget, body: OtlpBody): Promise<void> {
	const json = target.protocol === "http/json";
	const payload = json
		? JSON.stringify(body.json)
		: Buffer.from(body.signal === "metrics" ? encodeMetrics(body.json) : encodeLogs(body.json));
	const response = await fetch(target.url, {
		method: "POST",
		headers: { ...target.headers, "content-type": json ? "application/json" : "application/x-protobuf" },
		body: payload,
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`OTLP export to ${target.url} failed: HTTP ${response.status}`);
}
