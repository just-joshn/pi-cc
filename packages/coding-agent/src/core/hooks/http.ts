/** Running one http hook: the allowed-URL list, header interpolation limited to named variables, and no redirects. */

import type { HookSwitches, HttpHandler } from "./config.ts";
import { parseJsonOutput } from "./outcome.ts";
import type { RawResult } from "./process.ts";

/** Variables never interpolated into a header, even when a hook lists them. */
const CREDENTIAL_VARIABLES: ReadonlySet<string> = new Set([
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_IDENTITY_TOKEN",
	"AWS_CONTAINER_AUTHORIZATION_TOKEN",
	"CLOUDSDK_AUTH_ACCESS_TOKEN",
	"GOOGLE_OAUTH_ACCESS_TOKEN",
	"MCP_CLIENT_SECRET",
]);

const VARIABLE = /\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g;

/** Expands `$VAR` and `${VAR}` for the allowed names only. Anything else becomes the empty string. */
export function interpolateHeader(
	value: string,
	allowed: ReadonlySet<string>,
	env: Readonly<Record<string, string | undefined>>,
): string {
	return value
		.replace(VARIABLE, (_match, braced: string | undefined, bare: string | undefined) => {
			const name = braced ?? bare ?? "";
			if (!allowed.has(name) || CREDENTIAL_VARIABLES.has(name)) return "";
			return env[name] ?? "";
		})
		.replace(/[\r\n\0]/g, "");
}

/** `*` matches any run of characters, and the pattern must cover the whole URL. */
export function urlMatchesPattern(url: string, pattern: string): boolean {
	if (pattern === "*") return true;
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`).test(url);
}

export interface HttpContext {
	readonly switches: HookSwitches;
	readonly signal?: AbortSignal;
	readonly env?: Readonly<Record<string, string | undefined>>;
}

export async function runHttp(handler: HttpHandler, input: unknown, context: HttpContext): Promise<RawResult> {
	let normalizedUrl = handler.url;
	try {
		normalizedUrl = new URL(handler.url).href;
	} catch {
		return {
			code: null,
			stdout: "",
			stderr: `HTTP hook blocked: malformed URL ${handler.url}`,
		};
	}
	const { allowedHttpUrls, httpEnvVarCap } = context.switches;
	if (allowedHttpUrls && !allowedHttpUrls.some((pattern) => urlMatchesPattern(normalizedUrl, pattern))) {
		return {
			code: null,
			stdout: "",
			stderr: `HTTP hook blocked: ${normalizedUrl} does not match any pattern in allowedHttpHookUrls`,
		};
	}
	const named = httpEnvVarCap
		? handler.allowedEnvVars.filter((name) => httpEnvVarCap.includes(name))
		: handler.allowedEnvVars;
	const allowed = new Set(named);
	const env = context.env ?? process.env;
	const headers = Object.fromEntries(
		Object.entries(handler.headers).map(([name, value]) => [name, interpolateHeader(value, allowed, env)]),
	);
	const timeout = AbortSignal.timeout(handler.timeoutMs);
	const signal = context.signal ? AbortSignal.any([timeout, context.signal]) : timeout;
	try {
		const response = await fetch(normalizedUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify(input),
			redirect: "manual",
			signal,
		});
		const body = await response.text();
		if (response.status >= 200 && response.status < 300) {
			const json = parseJsonOutput(body);
			const stderr = json ? "" : `HTTP hook must return JSON, but got non-JSON response body: ${body}`;
			return { code: null, status: response.status, stdout: body, stderr };
		}
		return {
			code: null,
			status: response.status,
			stdout: "",
			stderr: `HTTP ${response.status} from ${normalizedUrl}`,
		};
	} catch (error) {
		if (context.signal?.aborted) return { code: null, stdout: "", stderr: "Hook cancelled", failure: "cancelled" };
		const timedOut = error instanceof Error && error.name === "TimeoutError";
		return {
			code: null,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
			failure: timedOut ? "timed out" : "failed to start",
		};
	}
}
