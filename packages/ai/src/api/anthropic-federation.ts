/**
 * Federation grants carry no refresh token, so expiry re-exchanges the identity
 * token, which is re-read on every exchange for rotation.
 */

import type { FetchFunction } from "../types.ts";
import { formatUserAgent } from "../utils/identity.ts";

// Variable specifier so browser bundlers do not try to resolve node builtins.
const importNodeModule = (specifier: string): Promise<unknown> => import(specifier);

export interface AnthropicFederationConfig {
	organization_id: string;
	workspace_id?: string;
	authentication: {
		type: "oidc_federation";
		federation_rule_id: string;
		service_account_id?: string;
		identity_token: { source: "file"; path: string };
	};
}

/** A federation token exchange failure. Not retried: it carries no HTTP status. */
export class AnthropicFederationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AnthropicFederationError";
	}
}

interface AccessToken {
	token: string;
	/** Unix epoch seconds. */
	expiresAt: number;
}

const TOKEN_ENDPOINT = "/v1/oauth/token";
const GRANT_TYPE_JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/** Routes the exchange to the federation service. */
const TOKEN_ENDPOINT_BETA = "oauth-2025-04-20,oidc-federation-2026-04-01";
const MAX_ASSERTION_BYTES = 16 * 1024;
// The SDK's own token cache thresholds. Inside the advisory window it served the cached token and
// refreshed in the background. Under the mandatory window it blocked on the exchange.
const ADVISORY_REFRESH_SECONDS = 120;
const MANDATORY_REFRESH_SECONDS = 30;
/** A failed background refresh waits this long before retrying, so an outage is not hammered. */
const ADVISORY_REFRESH_BACKOFF_SECONDS = 5;
const MAX_ERROR_BODY_CHARS = 2000;
/** RFC 6749 error fields; anything else in a token endpoint body may echo the assertion or a token. */
const SAFE_ERROR_FIELDS = ["error", "error_description", "error_uri"];

interface TokenCache {
	token?: AccessToken;
	exchange?: Promise<AccessToken>;
	/** Set by a rejected request, so the next request mints a token instead of joining an in-flight exchange. */
	force?: boolean;
	/** Unix epoch seconds of the last failed background refresh. */
	lastAdvisoryErrorAt?: number;
}

/** Per endpoint and config, so concurrent requests share one exchange. */
const tokenCaches = new Map<string, TokenCache>();

export async function getFederationBearerToken(
	config: AnthropicFederationConfig,
	baseUrl: string,
	fetch: FetchFunction,
): Promise<string> {
	const cache = cacheFor(baseUrl, config);
	const force = cache.force === true;
	cache.force = false;
	const cached = cache.token;

	if (!force && cached !== undefined) {
		const remaining = cached.expiresAt - nowInSeconds();
		if (remaining > ADVISORY_REFRESH_SECONDS) return cached.token;
		if (remaining > MANDATORY_REFRESH_SECONDS) {
			refreshInBackground(cache, config, baseUrl, fetch);
			return cached.token;
		}
	}

	return (await exchange(cache, config, baseUrl, fetch, force)).token;
}

/** Drops the cached token and forces the next request to exchange a new one. */
export function invalidateFederationToken(config: AnthropicFederationConfig, baseUrl: string): void {
	const cache = cacheFor(baseUrl, config);
	cache.token = undefined;
	cache.force = true;
}

function cacheFor(baseUrl: string, config: AnthropicFederationConfig): TokenCache {
	const key = JSON.stringify([baseUrl, config]);
	let cache = tokenCaches.get(key);
	if (cache === undefined) {
		cache = {};
		tokenCaches.set(key, cache);
	}
	return cache;
}

/** Runs one exchange per cache. Concurrent callers join it unless a rejected token forced a fresh one. */
function exchange(
	cache: TokenCache,
	config: AnthropicFederationConfig,
	baseUrl: string,
	fetch: FetchFunction,
	force: boolean,
): Promise<AccessToken> {
	if (cache.exchange !== undefined && !force) return cache.exchange;

	const pending = exchangeIdentityToken(config, baseUrl, fetch);
	cache.exchange = pending;
	return pending.then(
		(token) => {
			// A superseded exchange must not publish its token or drop its successor's handle.
			if (cache.exchange === pending) {
				cache.token = token;
				cache.exchange = undefined;
			}
			return token;
		},
		(error: unknown) => {
			if (cache.exchange === pending) cache.exchange = undefined;
			throw error;
		},
	);
}

function refreshInBackground(
	cache: TokenCache,
	config: AnthropicFederationConfig,
	baseUrl: string,
	fetch: FetchFunction,
): void {
	if (cache.exchange !== undefined) return;
	const lastError = cache.lastAdvisoryErrorAt;
	if (lastError !== undefined && nowInSeconds() - lastError < ADVISORY_REFRESH_BACKOFF_SECONDS) return;
	exchange(cache, config, baseUrl, fetch, false).catch(() => {
		cache.lastAdvisoryErrorAt = nowInSeconds();
	});
}

async function exchangeIdentityToken(
	config: AnthropicFederationConfig,
	baseUrl: string,
	fetch: FetchFunction,
): Promise<AccessToken> {
	const endpoint = baseUrl.replace(/\/+$/u, "");
	requireSecureEndpoint(endpoint);
	const assertion = await readIdentityToken(config.authentication.identity_token.path);
	if (assertion.length > MAX_ASSERTION_BYTES) {
		throw new AnthropicFederationError(
			`Identity token is ${Math.ceil(assertion.length / 1024)} KiB, exceeds the 16 KiB assertion limit`,
		);
	}

	const { organization_id, workspace_id } = config;
	const { federation_rule_id, service_account_id } = config.authentication;
	const url = `${endpoint}${TOKEN_ENDPOINT}`;
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"anthropic-beta": TOKEN_ENDPOINT_BETA,
				"user-agent": formatUserAgent(),
			},
			body: JSON.stringify({
				grant_type: GRANT_TYPE_JWT_BEARER,
				assertion,
				federation_rule_id,
				organization_id,
				...(service_account_id === undefined ? {} : { service_account_id }),
				...(workspace_id === undefined ? {} : { workspace_id }),
			}),
		});
	} catch (error) {
		throw new AnthropicFederationError(`Failed to reach token endpoint ${url}: ${error}`);
	}

	if (!response.ok) {
		// A bare 401 is hard to debug, so point at the likely cause and at the server-side event log.
		let hint = "";
		if (response.status === 401) {
			const workspaceHint = workspace_id
				? ""
				: "If your federation rule is scoped to multiple workspaces, set the ANTHROPIC_WORKSPACE_ID environment variable, the 'workspace_id' config key, or the `workspaceId` option. ";
			hint = ` Ensure your federation rule matches your identity token. ${workspaceHint}View your authentication events in the Workload identity page of Claude Console for more details.`;
		}
		const requestId = response.headers.get("request-id");
		throw new AnthropicFederationError(
			`Token exchange failed with status ${response.status}${requestId ? ` (request-id ${requestId})` : ""}: ${await describeFailure(response)}${hint}`,
		);
	}

	const data = await readTokenEndpointBody(response);
	const expiresIn = Number(data.expires_in);
	if (!Number.isFinite(expiresIn)) {
		throw new AnthropicFederationError(
			`Token endpoint response missing required fields: ${JSON.stringify(redactTokenBody(data))}`,
		);
	}
	return { token: data.access_token, expiresAt: nowInSeconds() + expiresIn };
}

/** A parsed token endpoint body; extra fields are kept only for redacted diagnostics. */
type TokenEndpointBody = Record<string, unknown> & {
	access_token: string;
	expires_in?: unknown;
};

async function readTokenEndpointBody(response: Response): Promise<TokenEndpointBody> {
	const text = await response.text();
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(text);
	} catch {
		throw new AnthropicFederationError(`Token endpoint returned non-JSON response (status ${response.status})`);
	}
	const accessToken = data.access_token;
	if (typeof accessToken !== "string" || accessToken.length === 0) {
		throw new AnthropicFederationError(
			`Token endpoint response missing access_token: ${JSON.stringify(redactTokenBody(data))}`,
		);
	}
	const tokenType = data.token_type;
	if (typeof tokenType === "string" && tokenType.toLowerCase() !== "bearer") {
		throw new AnthropicFederationError(
			`Token endpoint response: unsupported token_type "${tokenType}" (want Bearer)`,
		);
	}
	return { access_token: accessToken, expires_in: data.expires_in };
}

function redactTokenBody(body: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(SAFE_ERROR_FIELDS.filter((field) => field in body).map((field) => [field, body[field]]));
}

async function describeFailure(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	try {
		return JSON.stringify(redactTokenBody(JSON.parse(text)));
	} catch {
		return text.slice(0, MAX_ERROR_BODY_CHARS);
	}
}

async function readIdentityToken(path: string): Promise<string> {
	const fs = (await importNodeModule("node:fs/promises")) as {
		readFile(path: string, encoding: "utf8"): Promise<string>;
	};
	let content: string;
	try {
		content = await fs.readFile(path, "utf8");
	} catch (error) {
		throw new AnthropicFederationError(`Failed to read identity token file at ${path}: ${error}`);
	}
	const token = content.trim();
	if (token.length === 0) {
		throw new AnthropicFederationError(`Identity token file at ${path} is empty`);
	}
	return token;
}

/** Refuse to send a JWT over cleartext. Loopback is allowed for local development. */
function requireSecureEndpoint(endpoint: string): void {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch (error) {
		throw new AnthropicFederationError(`Invalid token endpoint base URL "${endpoint}": ${error}`);
	}
	if (url.protocol === "https:") return;
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
	if (url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1" || host === "::1")) return;
	throw new AnthropicFederationError(`Refusing to send credential over non-https token endpoint "${endpoint}"`);
}

function nowInSeconds(): number {
	return Math.floor(Date.now() / 1000);
}
