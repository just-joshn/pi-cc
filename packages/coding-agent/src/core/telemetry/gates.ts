/**
 * The local switches Claude Code reads before it talks to anyone about itself, mapped onto what pi-cc
 * can still send. pi-cc has no first-party event logging, remote feature-flag evaluation, or
 * error-reporting client, so these switches only gate pi's own outbound reports and the `/bug` command.
 * The operator's OpenTelemetry export is not behind them: Claude Code 2.1.312 exports to a collector with
 * all of them set (conformance case `telemetry/gates-honored`).
 */

type Env = Readonly<Record<string, string | undefined>>;

const isTruthy = (value: string | undefined): boolean =>
	["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
const isSet = (value: string | undefined): boolean => value !== undefined && value !== "";

/** Claude Code's `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`: any non-empty value. */
export function nonessentialTrafficDisabled(env: Env = process.env): boolean {
	return isSet(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC);
}

/**
 * True when `DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` (any non-empty value) or
 * `DO_NOT_TRACK` (1, true, yes, on) is set. pi's install-count ping stops on it.
 */
export function outboundReportingDisabled(env: Env = process.env): boolean {
	return nonessentialTrafficDisabled(env) || isSet(env.DISABLE_TELEMETRY) || isTruthy(env.DO_NOT_TRACK);
}

/** Why `/bug` is off, in Claude Code's wording for `/feedback`, or undefined when it is available. */
export function bugCommandDisabledReason(env: Env = process.env, command = "/bug"): string | undefined {
	if (isSet(env.DISABLE_FEEDBACK_COMMAND)) {
		return `${command} has been disabled via the DISABLE_FEEDBACK_COMMAND environment variable`;
	}
	if (isSet(env.DISABLE_BUG_COMMAND)) {
		return `${command} has been disabled via the DISABLE_BUG_COMMAND environment variable`;
	}
	if (nonessentialTrafficDisabled(env)) {
		return `${command} has been disabled via the CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC environment variable`;
	}
	return undefined;
}

/**
 * Whether pi may call hosts its upstream project owns (the pi.dev model catalog, GitHub release
 * downloads of `fd` and `rg`). Off unless `PI_CC_ALLOW_UPSTREAM_NETWORK` is on, and never when a
 * reporting gate is set. Calls the operator asks for, such as `/share`, `/bug` and the model client, are not behind it.
 */
export function upstreamNetworkAllowed(env: Env = process.env): boolean {
	return isTruthy(env.PI_CC_ALLOW_UPSTREAM_NETWORK) && !outboundReportingDisabled(env);
}
