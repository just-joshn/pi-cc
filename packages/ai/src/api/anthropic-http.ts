/** Transport for the Anthropic Messages endpoint. */

import type { FetchFunction, ProviderHeaders } from "../types.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import type { AnthropicMessageRequest } from "./anthropic-wire.ts";

const ANTHROPIC_VERSION = "2023-06-01";
const MESSAGES_PATH = "/v1/messages?beta=true";
const DEFAULT_TIMEOUT_MS = 600_000;
/** The beta every token-authenticated request carried while the SDK owned the token cache. */
export const OAUTH_API_BETA = "oauth-2025-04-20";

/**
 * `status` and `headers` are absent when the request never produced a
 * response, so retry logic can tell a transport failure from an HTTP status.
 */
export class AnthropicRequestError extends Error {
	readonly status: number | undefined;
	readonly headers: Headers | undefined;
	readonly type: string | null;

	constructor(
		message: string,
		options: {
			status?: number;
			headers?: Headers;
			/** The body's `error.type`. */
			type?: string | null;
			cause?: unknown;
		} = {},
	) {
		super(message, { cause: options.cause });
		this.name = "AnthropicRequestError";
		this.status = options.status;
		this.headers = options.headers;
		this.type = options.type ?? null;
	}
}

export interface AnthropicTransportOptions {
	signal?: AbortSignal;
	/** Default: 10 minutes. */
	timeoutMs?: number;
}

export interface AnthropicTransport {
	/** Returns the unread response; throws `AnthropicRequestError`. */
	postMessages(params: AnthropicMessageRequest, options?: AnthropicTransportOptions): Promise<Response>;
}

export interface AnthropicTransportConfig {
	/** API root, `Model.baseUrl`. */
	baseUrl: string;
	/** pi-owned headers: identity, session affinity, model and caller headers. */
	headers?: ProviderHeaders;
	/** Auth headers. Awaited per request, so a federated bearer can be refreshed. */
	authHeaders: () => Promise<ProviderHeaders>;
	/**
	 * Set when `authHeaders` returns a federation-minted bearer. Token auth carries the
	 * OAuth beta, and a 401 retires the token.
	 */
	federation?: { invalidate(): void };
	fetch?: FetchFunction;
}

export function createAnthropicTransport(config: AnthropicTransportConfig): AnthropicTransport {
	const fetch = config.fetch ?? globalThis.fetch;
	const url = `${config.baseUrl.replace(/\/+$/u, "")}${MESSAGES_PATH}`;

	return {
		async postMessages(params, options = {}) {
			const { betas: configuredBetas, ...body } = params;
			const betas = requestBetas(configuredBetas, config.federation !== undefined);
			const headers = providerHeadersToRecord(
				{
					accept: "application/json",
					"anthropic-version": ANTHROPIC_VERSION,
					"anthropic-dangerous-direct-browser-access": "true",
				},
				await config.authHeaders(),
				config.headers,
				{
					"content-type": "application/json",
					...(betas === undefined ? {} : { "anthropic-beta": betas.join(",") }),
				},
			);

			const response = await send(fetch, url, headers, JSON.stringify(body), options);
			if (!response.ok) {
				// The SDK dropped its token cache on a 401 so the next request minted a new token.
				if (response.status === 401) config.federation?.invalidate();
				throw await toRequestError(response);
			}
			return response;
		},
	};
}

function requestBetas(configured: string[] | undefined, isTokenAuth: boolean): string[] | undefined {
	if (!isTokenAuth) return configured;
	return [...new Set([...(configured ?? []), OAUTH_API_BETA])];
}

async function send(
	fetch: FetchFunction,
	url: string,
	headers: Record<string, string> | undefined,
	body: string,
	options: AnthropicTransportOptions,
): Promise<Response> {
	const callerSignal = options.signal;
	if (callerSignal?.aborted) {
		throw new AnthropicRequestError("Request was aborted.");
	}

	// The caller's abort stays linked to the live request until the body settles, so a read
	// pending on a stalled stream rejects instead of waiting for the next byte.
	// `AbortSignal.any` keeps no listener on the caller's signal, which outlives requests.
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const signal = callerSignal === undefined ? timeout.signal : AbortSignal.any([callerSignal, timeout.signal]);

	try {
		// The timeout covers the headers only, as the SDK's did; the body is the caller's to abort.
		return await fetch(url, { method: "POST", headers, body, signal });
	} catch (error) {
		if (callerSignal?.aborted) throw new AnthropicRequestError("Request was aborted.");
		if (timeout.signal.aborted) throw new AnthropicRequestError("Request timed out.");
		throw new AnthropicRequestError("Connection error.", { cause: error });
	} finally {
		clearTimeout(timer);
	}
}

async function toRequestError(response: Response): Promise<AnthropicRequestError> {
	const text = await response.text().catch(() => "");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = undefined;
	}

	const body = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	const detail = errorDetail(body, text);
	const errorBody = body?.error as { type?: unknown } | undefined;
	return new AnthropicRequestError(
		detail === undefined ? `${response.status} status code (no body)` : `${response.status} ${detail}`,
		{
			status: response.status,
			headers: response.headers,
			type: typeof errorBody?.type === "string" ? errorBody.type : null,
		},
	);
}

/** The body's own error text, which the strict tool fallback matches on. */
function errorDetail(body: Record<string, unknown> | undefined, text: string): string | undefined {
	const ownMessage = body?.message;
	if (ownMessage) {
		return typeof ownMessage === "string" ? ownMessage : JSON.stringify(ownMessage);
	}
	if (body !== undefined) return JSON.stringify(body);
	return text.length > 0 ? text : undefined;
}
