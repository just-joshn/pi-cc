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
const REFRESH_BEFORE_EXPIRY_SECONDS = 120;
const MAX_ERROR_BODY_CHARS = 2000;
/** RFC 6749 error fields; anything else in an error body may echo the assertion. */
const SAFE_ERROR_FIELDS = ["error", "error_description", "error_uri"];

/** In-flight and settled exchanges by endpoint and config, so concurrent requests mint one token. */
const exchanges = new Map<string, Promise<AccessToken>>();

export async function getFederationBearerToken(
	config: AnthropicFederationConfig,
	baseUrl: string,
	fetch: FetchFunction,
): Promise<string> {
	const key = cacheKey(baseUrl, config);
	let access = await exchangeOnce(key, config, baseUrl, fetch);
	if (access.expiresAt - nowInSeconds() <= REFRESH_BEFORE_EXPIRY_SECONDS) {
		exchanges.delete(key);
		access = await exchangeOnce(key, config, baseUrl, fetch);
	}
	return access.token;
}

/** Drops the cached token, so the next request exchanges a new one. */
export function invalidateFederationToken(config: AnthropicFederationConfig, baseUrl: string): void {
	exchanges.delete(cacheKey(baseUrl, config));
}

function cacheKey(baseUrl: string, config: AnthropicFederationConfig): string {
	return JSON.stringify([baseUrl, config]);
}

function exchangeOnce(
	key: string,
	config: AnthropicFederationConfig,
	baseUrl: string,
	fetch: FetchFunction,
): Promise<AccessToken> {
	const cached = exchanges.get(key);
	if (cached) return cached;

	const pending = exchangeIdentityToken(config, baseUrl, fetch);
	exchanges.set(key, pending);
	// A failed exchange must not stay cached, or every later request rethrows it.
	pending.catch(() => exchanges.delete(key));
	return pending;
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
	const response = await fetch(`${endpoint}${TOKEN_ENDPOINT}`, {
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

	if (!response.ok) {
		const hint =
			response.status === 401
				? " Set ANTHROPIC_WORKSPACE_ID if your federation rule covers more than one workspace."
				: "";
		throw new AnthropicFederationError(
			`Token exchange failed with status ${response.status}: ${await describeFailure(response)}.${hint}`,
		);
	}

	const data = await readTokenEndpointBody(response);
	const expiresIn = Number(data.expires_in);
	if (!Number.isFinite(expiresIn)) {
		throw new AnthropicFederationError(`Token endpoint response missing required fields: ${JSON.stringify(data)}`);
	}
	return { token: data.access_token, expiresAt: nowInSeconds() + expiresIn };
}

interface TokenEndpointBody {
	access_token: string;
	expires_in?: number;
}

async function readTokenEndpointBody(response: Response): Promise<TokenEndpointBody> {
	const text = await response.text();
	let data: { access_token?: unknown; expires_in?: unknown; token_type?: unknown };
	try {
		data = JSON.parse(text);
	} catch {
		throw new AnthropicFederationError(`Token endpoint returned non-JSON response (status ${response.status})`);
	}
	if (typeof data.access_token !== "string" || data.access_token.length === 0) {
		throw new AnthropicFederationError(`Token endpoint response missing access_token: ${JSON.stringify(data)}`);
	}
	if (typeof data.token_type === "string" && data.token_type.toLowerCase() !== "bearer") {
		throw new AnthropicFederationError(
			`Token endpoint response: unsupported token_type "${data.token_type}" (want Bearer)`,
		);
	}
	return {
		access_token: data.access_token,
		expires_in: typeof data.expires_in === "number" ? data.expires_in : Number.NaN,
	};
}

async function describeFailure(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	try {
		const parsed = JSON.parse(text) as Record<string, unknown>;
		const safe = Object.fromEntries(
			SAFE_ERROR_FIELDS.filter((field) => field in parsed).map((field) => [field, parsed[field]]),
		);
		return JSON.stringify(safe);
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
