import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TELEMETRY_DIR = fileURLToPath(new URL("../src/core/telemetry/", import.meta.url));
const VENDORS = /anthropic\.com|com\.anthropic|statsig|growthbook|sentry|datadog|segment\.io|amplitude/i;

describe("telemetry sources", () => {
	it("name no Anthropic host or telemetry vendor", () => {
		const offenders = readdirSync(TELEMETRY_DIR)
			.filter((file) => file.endsWith(".ts"))
			.filter((file) => VENDORS.test(readFileSync(join(TELEMETRY_DIR, file), "utf8")));
		expect(offenders).toEqual([]);
	});
});
