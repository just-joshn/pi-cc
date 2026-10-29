/** Transport for the Anthropic Messages endpoint. */

import type { FetchFunction, ProviderHeaders } from "../types.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import type { AnthropicMessageRequest } from "./anthropic-wire.ts";

const ANTHROPIC_VERSION = "2023-06-01";
const MESSAGES_PATH = "/v1/messages?beta=true";
const DEFAULT_TIMEOUT_MS = 600_000;

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
	fetch?: FetchFunction;
}

export function createAnthropicTransport(config: AnthropicTransportConfig): AnthropicTransport {
	const fetch = config.fetch ?? globalThis.fetch;
	const url = `${config.baseUrl.replace(/\/+$/u, "")}${MESSAGES_PATH}`;

	return {
		async postMessages(params, options = {}) {
			const { betas, ...body } = params;
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
				throw await toRequestError(response);
			}
			return response;
		},
	};
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

	// A merged controller, so the caller's abort and the timeout both cancel the fetch.
	const controller = new AbortController();
	const abort = () => controller.abort();
	callerSignal?.addEventListener("abort", abort, { once: true });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		abort();
	}, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

	try {
		return await fetch(url, { method: "POST", headers, body, signal: controller.signal });
	} catch (error) {
		if (callerSignal?.aborted) throw new AnthropicRequestError("Request was aborted.");
		if (timedOut) throw new AnthropicRequestError("Request timed out.");
		throw new AnthropicRequestError("Connection error.", { cause: error });
	} finally {
		clearTimeout(timer);
		callerSignal?.removeEventListener("abort", abort);
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
