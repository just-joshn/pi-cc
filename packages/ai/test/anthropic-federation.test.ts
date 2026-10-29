import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AnthropicOptions, stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { createModels } from "../src/models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { type RecordedAnthropicRequest, recordFetch } from "./anthropic-utils.ts";

function sseResponse(): Response {
	const body = [
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } },
		})}\n`,
		`event: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 1 },
		})}\n`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
	].join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function federationFetch() {
	return recordFetch((request) =>
		request.url.pathname === "/v1/oauth/token"
			? Response.json({ access_token: "federated-token", expires_in: 3600 })
			: sseResponse(),
	);
}

function tokenRequest(requests: RecordedAnthropicRequest[]): RecordedAnthropicRequest | undefined {
	return requests.find((request) => request.url.pathname === "/v1/oauth/token");
}

function messageRequest(requests: RecordedAnthropicRequest[]): RecordedAnthropicRequest | undefined {
	return requests.find((request) => request.url.pathname === "/v1/messages");
}

const neverAbortedSignal = new AbortController().signal;

let tempDir: string;
let federationEnv: Record<string, string>;

beforeAll(() => {
	// The exchange reads the projected identity token, so the path must exist.
	tempDir = mkdtempSync(join(tmpdir(), "pi-anthropic-federation-"));
	const identityTokenFile = join(tempDir, "identity.jwt");
	writeFileSync(identityTokenFile, "header.payload.signature");
	federationEnv = {
		ANTHROPIC_FEDERATION_RULE_ID: "fdrl_test",
		ANTHROPIC_ORGANIZATION_ID: "org-test",
		ANTHROPIC_SERVICE_ACCOUNT_ID: "svac_test",
		ANTHROPIC_IDENTITY_TOKEN_FILE: identityTokenFile,
	};
});

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

const context = normalizeContext({
	systemPrompt: "System prompt.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
});

const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
};

function resolveWithEnv(env: Record<string, string>) {
	return anthropicProvider().auth.apiKey?.resolve({
		ctx: { env: async (name) => env[name], fileExists: async () => false },
		signal: neverAbortedSignal,
	});
}

// https://github.com/earendil-works/pi/issues/10177
describe("Anthropic workload identity federation", () => {
	it("resolves the federation variables as provider env with no request auth", async () => {
		expect(await resolveWithEnv(federationEnv)).toEqual({
			auth: {},
			env: federationEnv,
			source: "workload identity federation",
		});
	});

	it("passes ANTHROPIC_WORKSPACE_ID through when set", async () => {
		const result = await resolveWithEnv({ ...federationEnv, ANTHROPIC_WORKSPACE_ID: "wrkspc_test" });
		expect(result?.env?.ANTHROPIC_WORKSPACE_ID).toBe("wrkspc_test");
	});

	it("is not configured when a federation variable is missing", async () => {
		const { ANTHROPIC_IDENTITY_TOKEN_FILE: _omitted, ...partial } = federationEnv;
		expect(await resolveWithEnv(partial)).toBeUndefined();
	});

	it("treats ANTHROPIC_SERVICE_ACCOUNT_ID as optional, like the SDK", async () => {
		const { ANTHROPIC_SERVICE_ACCOUNT_ID: _omitted, ...partial } = federationEnv;
		expect(await resolveWithEnv(partial)).toEqual({
			auth: {},
			env: partial,
			source: "workload identity federation",
		});

		const { requests, fetch } = federationFetch();
		await streamAnthropic(anthropicModel, context, { env: partial, fetch }).result();

		const exchange = tokenRequest(requests)?.body;
		expect(exchange).toMatchObject({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			federation_rule_id: "fdrl_test",
			organization_id: "org-test",
		});
		expect(exchange).not.toHaveProperty("service_account_id");
	});

	it("keeps API key and auth token precedence over federation", async () => {
		expect(await resolveWithEnv({ ...federationEnv, ANTHROPIC_API_KEY: "api-key" })).toEqual({
			auth: { apiKey: "api-key" },
			source: "ANTHROPIC_API_KEY",
		});
		expect(await resolveWithEnv({ ...federationEnv, ANTHROPIC_AUTH_TOKEN: "auth-token" })).toEqual({
			auth: { headers: { Authorization: "Bearer auth-token" } },
			source: "ANTHROPIC_AUTH_TOKEN",
		});
	});

	it("exchanges the identity token and sends the minted token as a bearer", async () => {
		const { requests, fetch } = federationFetch();
		await streamAnthropic(anthropicModel, context, { env: federationEnv, fetch }).result();

		expect(requests.map((request) => request.url.pathname)).toEqual(["/v1/oauth/token", "/v1/messages"]);
		expect(tokenRequest(requests)?.body).toMatchObject({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion: "header.payload.signature",
			federation_rule_id: "fdrl_test",
			organization_id: "org-test",
			service_account_id: "svac_test",
		});
		const message = messageRequest(requests);
		expect(message?.headers.get("authorization")).toBe("Bearer federated-token");
		expect(message?.headers.get("x-api-key")).toBeNull();
		expect(message?.body.betas).toBeUndefined();
		// The SDK added the OAuth beta to token-authenticated requests, so a federated
		// bearer carried it too.
		expect(message?.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
	});

	it("merges the OAuth beta into pi's betas for a federated bearer without duplicates", async () => {
		const { requests, fetch } = federationFetch();
		// A fresh endpoint, so the previous test's cached token does not hide the exchange.
		const endpoint: Model<"anthropic-messages"> = {
			...anthropicModel,
			baseUrl: "https://federation-betas.example",
		};

		await streamAnthropic(endpoint, context, {
			env: federationEnv,
			fetch,
			headers: { "anthropic-beta": "custom-beta, oauth-2025-04-20" },
		}).result();
		await streamAnthropic(endpoint, context, {
			env: federationEnv,
			fetch,
			headers: { "anthropic-beta": "custom-beta" },
		}).result();

		const betas = requests
			.filter((request) => request.url.pathname === "/v1/messages")
			.map((request) => request.headers.get("anthropic-beta"));
		expect(betas).toEqual(["custom-beta,oauth-2025-04-20", "custom-beta,oauth-2025-04-20"]);
	});

	it("exchanges a new token after the current one is rejected with 401", async () => {
		let exchanges = 0;
		let rejected = false;
		const { requests, fetch } = recordFetch((request) => {
			if (request.url.pathname === "/v1/oauth/token") {
				exchanges += 1;
				return Response.json({ access_token: `federated-token-${exchanges}`, expires_in: 3600 });
			}
			if (rejected) return sseResponse();
			rejected = true;
			return Response.json(
				{ type: "error", error: { type: "authentication_error", message: "expired" } },
				{ status: 401 },
			);
		});
		// A fresh endpoint, so the previous test's cached token does not hide the exchange.
		const endpoint: Model<"anthropic-messages"> = { ...anthropicModel, baseUrl: "https://federation-401.example" };

		const first = await streamAnthropic(endpoint, context, { env: federationEnv, fetch }).result();
		const second = await streamAnthropic(endpoint, context, { env: federationEnv, fetch }).result();

		expect(first.stopReason).toBe("error");
		expect(second.stopReason).toBe("stop");
		expect(requests.map((request) => request.url.pathname)).toEqual([
			"/v1/oauth/token",
			"/v1/messages",
			"/v1/oauth/token",
			"/v1/messages",
		]);
		expect(requests.at(-1)?.headers.get("authorization")).toBe("Bearer federated-token-2");
	});

	it("accepts a numeric string expires_in, like the SDK's Number() coercion", async () => {
		const { requests, fetch } = recordFetch((request) =>
			request.url.pathname === "/v1/oauth/token"
				? Response.json({ access_token: "federated-token", token_type: "Bearer", expires_in: "3600" })
				: sseResponse(),
		);
		// A fresh endpoint, so the previous test's cached token does not hide the exchange.
		const endpoint: Model<"anthropic-messages"> = {
			...anthropicModel,
			baseUrl: "https://federation-expires.example",
		};

		const message = await streamAnthropic(endpoint, context, { env: federationEnv, fetch }).result();

		expect(message.stopReason).toBe("stop");
		expect(messageRequest(requests)?.headers.get("authorization")).toBe("Bearer federated-token");
	});

	it("keeps token values out of a rejected token response", async () => {
		const noExpiry = recordFetch((request) =>
			request.url.pathname === "/v1/oauth/token"
				? Response.json({ access_token: "SECRET-ACCESS", token_type: "Bearer" })
				: sseResponse(),
		);
		const missingExpiry = await streamAnthropic(
			{ ...anthropicModel, baseUrl: "https://federation-no-expiry.example" },
			context,
			{ env: federationEnv, fetch: noExpiry.fetch },
		).result();

		expect(missingExpiry.stopReason).toBe("error");
		expect(missingExpiry.errorMessage).toBe("Token endpoint response missing required fields: {}");

		const noToken = recordFetch((request) =>
			request.url.pathname === "/v1/oauth/token"
				? Response.json({ token_type: "Bearer", expires_in: 3600, refresh_token: "SECRET-REFRESH" })
				: sseResponse(),
		);
		const missingToken = await streamAnthropic(
			{ ...anthropicModel, baseUrl: "https://federation-no-token.example" },
			context,
			{ env: federationEnv, fetch: noToken.fetch },
		).result();

		expect(missingToken.stopReason).toBe("error");
		expect(missingToken.errorMessage).toBe("Token endpoint response missing access_token: {}");
	});

	it("reports the request id and the guidance the SDK gave for a 401", async () => {
		const { fetch } = recordFetch(() =>
			Response.json(
				{ error: "invalid_grant", access_token: "SECRET-ACCESS" },
				{ status: 401, headers: { "request-id": "req_tok" } },
			),
		);
		const message = await streamAnthropic(
			{ ...anthropicModel, baseUrl: "https://federation-401-error.example" },
			context,
			{ env: federationEnv, fetch },
		).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe(
			'Token exchange failed with status 401 (request-id req_tok): {"error":"invalid_grant"} Ensure your federation rule matches your identity token. If your federation rule is scoped to multiple workspaces, set the ANTHROPIC_WORKSPACE_ID environment variable, the \'workspace_id\' config key, or the `workspaceId` option. View your authentication events in the Workload identity page of Claude Console for more details.',
		);
	});

	it("omits the workspace guidance from a 401 when a workspace id is configured", async () => {
		const { fetch } = recordFetch(() =>
			Response.json({ error: "invalid_grant" }, { status: 401, headers: { "request-id": "req_tok" } }),
		);
		const message = await streamAnthropic(
			{ ...anthropicModel, baseUrl: "https://federation-401-workspace.example" },
			context,
			{ env: { ...federationEnv, ANTHROPIC_WORKSPACE_ID: "wrkspc_test" }, fetch },
		).result();

		expect(message.errorMessage).toBe(
			'Token exchange failed with status 401 (request-id req_tok): {"error":"invalid_grant"} Ensure your federation rule matches your identity token. View your authentication events in the Workload identity page of Claude Console for more details.',
		);
	});

	it("drops a token-shaped field from a non-2xx token endpoint body", async () => {
		const { fetch } = recordFetch(() =>
			Response.json(
				{ error: "server_error", error_description: "boom", access_token: "SECRET-ACCESS" },
				{ status: 500, headers: { "request-id": "req_tok" } },
			),
		);
		const message = await streamAnthropic({ ...anthropicModel, baseUrl: "https://federation-500.example" }, context, {
			env: federationEnv,
			fetch,
		}).result();

		expect(message.errorMessage).toBe(
			'Token exchange failed with status 500 (request-id req_tok): {"error":"server_error","error_description":"boom"}',
		);
	});

	it("names the token endpoint and the cause when the exchange cannot reach it", async () => {
		const fetch: NonNullable<AnthropicOptions["fetch"]> = async () => {
			throw new TypeError("fetch failed");
		};
		const message = await streamAnthropic(
			{ ...anthropicModel, baseUrl: "https://federation-network.example" },
			context,
			{ env: federationEnv, fetch },
		).result();

		expect(message.errorMessage).toBe(
			"Failed to reach token endpoint https://federation-network.example/v1/oauth/token: TypeError: fetch failed",
		);
	});

	it("threads authContext federation variables through Models", async () => {
		const models = createModels({
			authContext: {
				env: async (name) => federationEnv[name as keyof typeof federationEnv],
				fileExists: async () => false,
			},
		});
		models.setProvider(anthropicProvider());

		const { requests, fetch } = federationFetch();
		// A fresh endpoint, so the previous test's cached token does not hide the exchange.
		const otherEndpoint: Model<"anthropic-messages"> = {
			...anthropicModel,
			baseUrl: "https://federation-models.example",
		};
		await models.streamSimple(otherEndpoint, context, { fetch }).result();

		expect(tokenRequest(requests)?.body).toMatchObject({ organization_id: "org-test" });
		expect(messageRequest(requests)?.headers.get("authorization")).toBe("Bearer federated-token");
	});

	it("lets an explicit API key win over federation env", async () => {
		const { requests, fetch } = federationFetch();
		await streamAnthropic(anthropicModel, context, {
			apiKey: "explicit-key",
			env: federationEnv,
			fetch,
		}).result();

		expect(requests.map((request) => request.url.pathname)).toEqual(["/v1/messages"]);
		expect(requests[0].headers.get("x-api-key")).toBe("explicit-key");
		expect(requests[0].headers.get("authorization")).toBeNull();
	});

	it("does not federate other anthropic-messages providers", async () => {
		const kimi: Model<"anthropic-messages"> = {
			...anthropicModel,
			provider: "kimi-coding",
			baseUrl: "https://api.kimi.com/coding",
		};
		const { requests, fetch } = federationFetch();
		const message = await streamAnthropic(kimi, context, { env: federationEnv, fetch }).result();

		expect(message.stopReason).toBe("error");
		expect(requests).toHaveLength(0);
	});
});
