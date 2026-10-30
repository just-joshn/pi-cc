/** OTLP/JSON request bodies for the Claude Code metrics and events, in the shape the operator's collector expects. */

export type AttributeValue = string | number | boolean;
export type Attributes = Readonly<Record<string, AttributeValue>>;

export interface SumPoint {
	readonly name: string;
	readonly unit: string;
	readonly attributes: Attributes;
	readonly value: number;
}

export interface LogEvent {
	readonly name: string;
	readonly timeMs: number;
	readonly attributes: Attributes;
}

export interface AnyValueJson {
	stringValue?: string;
	boolValue?: boolean;
	intValue?: number;
	doubleValue?: number;
}

export interface KeyValueJson {
	key: string;
	value: AnyValueJson;
}

export interface ScopeJson {
	name: string;
	version: string;
}

export interface MetricsBody {
	resourceMetrics: {
		resource: { attributes: KeyValueJson[] };
		scopeMetrics: {
			scope: ScopeJson;
			metrics: {
				name: string;
				unit: string;
				sum: {
					aggregationTemporality: 1 | 2;
					isMonotonic: boolean;
					dataPoints: {
						attributes: KeyValueJson[];
						startTimeUnixNano: string;
						timeUnixNano: string;
						asDouble: number;
					}[];
				};
			}[];
		}[];
	}[];
}

export interface LogsBody {
	resourceLogs: {
		resource: { attributes: KeyValueJson[] };
		scopeLogs: {
			scope: ScopeJson;
			logRecords: {
				timeUnixNano: string;
				observedTimeUnixNano: string;
				body: AnyValueJson;
				attributes: KeyValueJson[];
			}[];
		}[];
	}[];
}

const nanos = (ms: number): string => `${BigInt(Math.round(ms)) * 1_000_000n}`;

function anyValue(value: AttributeValue): AnyValueJson {
	if (typeof value === "string") return { stringValue: value };
	if (typeof value === "boolean") return { boolValue: value };
	return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
}

const keyValues = (attributes: Attributes): KeyValueJson[] =>
	Object.entries(attributes).map(([key, value]) => ({ key, value: anyValue(value) }));

/** Temporality 1 is delta, which is the default. 2 is cumulative. */
export function metricsBody(
	resource: Attributes,
	scope: ScopeJson,
	points: readonly SumPoint[],
	startMs: number,
	endMs: number,
	temporality: 1 | 2,
): MetricsBody {
	const metrics = [...new Set(points.map((point) => point.name))].map((name) => {
		const mine = points.filter((point) => point.name === name);
		return {
			name,
			unit: mine[0]?.unit ?? "",
			sum: {
				aggregationTemporality: temporality,
				isMonotonic: true,
				dataPoints: mine.map((point) => ({
					attributes: keyValues(point.attributes),
					startTimeUnixNano: nanos(startMs),
					timeUnixNano: nanos(endMs),
					asDouble: point.value,
				})),
			},
		};
	});
	return { resourceMetrics: [{ resource: { attributes: keyValues(resource) }, scopeMetrics: [{ scope, metrics }] }] };
}

export function logsBody(resource: Attributes, scope: ScopeJson, events: readonly LogEvent[]): LogsBody {
	const logRecords = events.map((event) => ({
		timeUnixNano: nanos(event.timeMs),
		observedTimeUnixNano: nanos(event.timeMs),
		body: { stringValue: `claude_code.${event.name}` },
		attributes: keyValues({ ...event.attributes }),
	}));
	return { resourceLogs: [{ resource: { attributes: keyValues(resource) }, scopeLogs: [{ scope, logRecords }] }] };
}
