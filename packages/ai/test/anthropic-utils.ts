import type { AnthropicOptions } from "../src/api/anthropic-messages.ts";

export interface RecordedAnthropicRequest {
	url: URL;
	headers: Headers;
	body: Record<string, unknown>;
}

export function recordFetch(respond: (request: RecordedAnthropicRequest) => Response) {
	const requests: RecordedAnthropicRequest[] = [];

	const fetch: NonNullable<AnthropicOptions["fetch"]> = async (input, init) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const request: RecordedAnthropicRequest = {
			url,
			headers: new Headers(init?.headers),
			body: JSON.parse(String(init?.body)),
		};
		requests.push(request);
		return respond(request);
	};

	return { requests, fetch };
}

export function responseFetch(response: Response): NonNullable<AnthropicOptions["fetch"]> {
	return recordFetch(() => response).fetch;
}
