/**
 * Hand-encoded OTLP protobuf (opentelemetry-proto collector v1) for `http/protobuf`, built from the JSON
 * bodies in otlp.ts. Field numbers follow the public .proto files, so the encoder needs no protobuf library.
 */

import type { AnyValueJson, KeyValueJson, LogsBody, MetricsBody, ScopeJson } from "./otlp.ts";

const concat = (parts: readonly Uint8Array[]): Uint8Array => Buffer.concat(parts);

function varint(value: bigint): Uint8Array {
	const bytes: number[] = [];
	let rest = BigInt.asUintN(64, value);
	while (rest >= 0x80n) {
		bytes.push(Number(rest & 0x7fn) | 0x80);
		rest >>= 7n;
	}
	bytes.push(Number(rest));
	return Uint8Array.from(bytes);
}

const tag = (field: number, wireType: number): Uint8Array => varint(BigInt((field << 3) | wireType));
const varintField = (field: number, value: bigint | number): Uint8Array =>
	concat([tag(field, 0), varint(BigInt(value))]);
const bytesField = (field: number, body: Uint8Array): Uint8Array =>
	concat([tag(field, 2), varint(BigInt(body.length)), body]);
const stringField = (field: number, value: string): Uint8Array => bytesField(field, Buffer.from(value, "utf8"));

function fixed64(field: number, value: bigint): Uint8Array {
	const buffer = Buffer.alloc(8);
	buffer.writeBigUInt64LE(value);
	return concat([tag(field, 1), buffer]);
}

function double(field: number, value: number): Uint8Array {
	const buffer = Buffer.alloc(8);
	buffer.writeDoubleLE(value);
	return concat([tag(field, 1), buffer]);
}

/** AnyValue: string_value=1, bool_value=2, int_value=3, double_value=4. */
function anyValue(value: AnyValueJson): Uint8Array {
	if (value.stringValue !== undefined) return stringField(1, value.stringValue);
	if (value.boolValue !== undefined) return varintField(2, value.boolValue ? 1 : 0);
	if (value.intValue !== undefined) return varintField(3, value.intValue);
	return double(4, value.doubleValue ?? 0);
}

/** KeyValue: key=1, value=2. */
const keyValues = (field: number, list: readonly KeyValueJson[]): Uint8Array[] =>
	list.map((entry) => bytesField(field, concat([stringField(1, entry.key), bytesField(2, anyValue(entry.value))])));

/** InstrumentationScope: name=1, version=2. */
const scope = (value: ScopeJson): Uint8Array => concat([stringField(1, value.name), stringField(2, value.version)]);

/** Resource: attributes=1. */
const resource = (value: { attributes: KeyValueJson[] }): Uint8Array => concat(keyValues(1, value.attributes));

type MetricJson = MetricsBody["resourceMetrics"][number]["scopeMetrics"][number]["metrics"][number];

/** Metric: name=1, unit=3, sum=7. Sum: data_points=1, temporality=2, is_monotonic=3. NumberDataPoint: start=2, time=3, as_double=4, attributes=7. */
function metric(value: MetricJson): Uint8Array {
	const points = value.sum.dataPoints.map((point) =>
		bytesField(
			1,
			concat([
				fixed64(2, BigInt(point.startTimeUnixNano)),
				fixed64(3, BigInt(point.timeUnixNano)),
				double(4, point.asDouble),
				...keyValues(7, point.attributes),
			]),
		),
	);
	const sum = concat([
		...points,
		varintField(2, value.sum.aggregationTemporality),
		varintField(3, value.sum.isMonotonic ? 1 : 0),
	]);
	return concat([stringField(1, value.name), stringField(3, value.unit), bytesField(7, sum)]);
}

/** ExportMetricsServiceRequest: resource_metrics=1. ResourceMetrics: resource=1, scope_metrics=2. ScopeMetrics: scope=1, metrics=2. */
export function encodeMetrics(body: MetricsBody): Uint8Array {
	return concat(
		body.resourceMetrics.map((entry) =>
			bytesField(
				1,
				concat([
					bytesField(1, resource(entry.resource)),
					...entry.scopeMetrics.map((scoped) =>
						bytesField(
							2,
							concat([
								bytesField(1, scope(scoped.scope)),
								...scoped.metrics.map((m) => bytesField(2, metric(m))),
							]),
						),
					),
				]),
			),
		),
	);
}

type RecordJson = LogsBody["resourceLogs"][number]["scopeLogs"][number]["logRecords"][number];

/** LogRecord: time_unix_nano=1, body=5, attributes=6, observed_time_unix_nano=11. */
const logRecord = (value: RecordJson): Uint8Array =>
	concat([
		fixed64(1, BigInt(value.timeUnixNano)),
		bytesField(5, anyValue(value.body)),
		...keyValues(6, value.attributes),
		fixed64(11, BigInt(value.observedTimeUnixNano)),
	]);

/** ExportLogsServiceRequest: resource_logs=1. ResourceLogs: resource=1, scope_logs=2. ScopeLogs: scope=1, log_records=2. */
export function encodeLogs(body: LogsBody): Uint8Array {
	return concat(
		body.resourceLogs.map((entry) =>
			bytesField(
				1,
				concat([
					bytesField(1, resource(entry.resource)),
					...entry.scopeLogs.map((scoped) =>
						bytesField(
							2,
							concat([
								bytesField(1, scope(scoped.scope)),
								...scoped.logRecords.map((r) => bytesField(2, logRecord(r))),
							]),
						),
					),
				]),
			),
		),
	);
}
