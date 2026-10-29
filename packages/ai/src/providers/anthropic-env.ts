/**
 * `ANTHROPIC_BASE_URL` and `ANTHROPIC_CUSTOM_HEADERS`, the endpoint half of Claude Code's provider env.
 *
 * The header text is Claude Code's own parse. One `Name: value` per line, the first colon splits, name
 * and value are trimmed, a line with no colon or an empty name is skipped, and a later spelling of a
 * repeated name replaces an earlier one. It never throws: a name `fetch` rejects has to fail at request
 * time, as it does today, rather than turning a bad header into an auth failure.
 */

import type { AuthContext, AuthEnvironment } from "../auth/types.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";

const BASE_URL_ENV = "ANTHROPIC_BASE_URL";
const CUSTOM_HEADERS_ENV = "ANTHROPIC_CUSTOM_HEADERS";

/** One header per line, `Name: value`. `undefined` when no line yields a header. */
export function parseCustomHeaders(text: string | undefined): Record<string, string> | undefined {
	if (text === undefined) return undefined;
	const lines: Record<string, string>[] = [];
	for (const line of text.split(/\r?\n/u)) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const name = line.slice(0, colon).trim();
		if (name.length === 0) continue;
		lines.push({ [name]: line.slice(colon + 1).trim() });
	}
	return providerHeadersToRecord(...lines);
}

export async function readAnthropicEnvironment(context: AuthContext): Promise<AuthEnvironment | undefined> {
	const baseUrl = (await context.env(BASE_URL_ENV))?.trim() || undefined;
	const headers = parseCustomHeaders(await context.env(CUSTOM_HEADERS_ENV));
	if (baseUrl === undefined && headers === undefined) return undefined;
	return {
		...(baseUrl === undefined ? {} : { baseUrl }),
		...(headers === undefined ? {} : { headers }),
		...(headers !== undefined && hasRequestAuth(headers) ? { authenticated: true } : {}),
	};
}

/** A custom `authorization` or `x-api-key` is itself the request credential, so the provider is configured. */
function hasRequestAuth(headers: Record<string, string>): boolean {
	return Object.entries(headers).some(
		([name, value]) =>
			value.length > 0 && (name.toLowerCase() === "authorization" || name.toLowerCase() === "x-api-key"),
	);
}
