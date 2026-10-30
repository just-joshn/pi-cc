import { describe, expect, it } from "vitest";
import { autoUpdateState } from "../src/cli/update-gates.ts";
import { SETTINGS_DEFAULTS } from "../src/core/settings-defaults.ts";
import {
	bugCommandDisabledReason,
	nonessentialTrafficDisabled,
	outboundReportingDisabled,
	upstreamNetworkAllowed,
} from "../src/core/telemetry/gates.ts";
import { isInstallTelemetryEnabled } from "../src/core/telemetry.ts";

describe("outboundReportingDisabled", () => {
	it("is off with nothing set", () => {
		expect(outboundReportingDisabled({})).toBe(false);
	});

	it.each([
		["DISABLE_TELEMETRY", "1"],
		["DISABLE_TELEMETRY", "anything"],
		["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"],
		["DO_NOT_TRACK", "1"],
		["DO_NOT_TRACK", "true"],
	])("%s=%s turns reporting off", (name, value) => {
		expect(outboundReportingDisabled({ [name]: value })).toBe(true);
	});

	it("reads DO_NOT_TRACK as a boolean and the other two as any non-empty value", () => {
		expect(outboundReportingDisabled({ DO_NOT_TRACK: "0" })).toBe(false);
		expect(outboundReportingDisabled({ DISABLE_TELEMETRY: "" })).toBe(false);
		expect(outboundReportingDisabled({ DISABLE_TELEMETRY: "0" })).toBe(true);
	});

	it("counts the nonessential-traffic gate as set for any non-empty raw value, as the update gate does", () => {
		for (const value of ["1", "0", "false", " "]) {
			const env = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: value };
			expect(nonessentialTrafficDisabled(env)).toBe(true);
			expect(autoUpdateState(env).kind).toBe("disabled");
		}
		expect(nonessentialTrafficDisabled({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "" })).toBe(false);
	});
});

describe("bugCommandDisabledReason", () => {
	it("is available with nothing set", () => {
		expect(bugCommandDisabledReason({})).toBeUndefined();
	});

	it("names the variable that disabled it, in Claude Code's order", () => {
		expect(bugCommandDisabledReason({ DISABLE_BUG_COMMAND: "1" })).toBe(
			"/bug has been disabled via the DISABLE_BUG_COMMAND environment variable",
		);
		expect(bugCommandDisabledReason({ DISABLE_FEEDBACK_COMMAND: "1", DISABLE_BUG_COMMAND: "1" })).toContain(
			"DISABLE_FEEDBACK_COMMAND",
		);
		expect(bugCommandDisabledReason({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" })).toContain(
			"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
		);
	});

	it("leaves /bug alone for DISABLE_TELEMETRY, as Claude Code does", () => {
		expect(bugCommandDisabledReason({ DISABLE_TELEMETRY: "1" })).toBeUndefined();
	});
});

describe("install telemetry", () => {
	it("is off by default", () => {
		expect(SETTINGS_DEFAULTS.enableInstallTelemetry).toBe(false);
	});

	it("stays off under a reporting gate even when PI_TELEMETRY asks for it", () => {
		const settings = { getEnableInstallTelemetry: () => true } as Parameters<typeof isInstallTelemetryEnabled>[0];
		expect(isInstallTelemetryEnabled(settings, "1", {})).toBe(true);
		expect(isInstallTelemetryEnabled(settings, "1", { DISABLE_TELEMETRY: "1" })).toBe(false);
		expect(isInstallTelemetryEnabled(settings, undefined, { DO_NOT_TRACK: "1" })).toBe(false);
	});
});

describe("upstreamNetworkAllowed", () => {
	it("is off unless PI_CC_ALLOW_UPSTREAM_NETWORK is on", () => {
		expect(upstreamNetworkAllowed({})).toBe(false);
		expect(upstreamNetworkAllowed({ PI_CC_ALLOW_UPSTREAM_NETWORK: "1" })).toBe(true);
	});

	it("stays off under a reporting gate", () => {
		expect(upstreamNetworkAllowed({ PI_CC_ALLOW_UPSTREAM_NETWORK: "1", DISABLE_TELEMETRY: "1" })).toBe(false);
	});
});
