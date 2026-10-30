import type { SettingsManager } from "./settings-manager.ts";
import { outboundReportingDisabled } from "./telemetry/gates.ts";

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export function isInstallTelemetryEnabled(
	settingsManager: SettingsManager,
	telemetryEnv: string | undefined = process.env.PI_TELEMETRY,
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	if (outboundReportingDisabled(env)) return false;
	return telemetryEnv !== undefined ? isTruthyEnvFlag(telemetryEnv) : settingsManager.getEnableInstallTelemetry();
}
