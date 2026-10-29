import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { resolveProviderAuth } from "../src/auth/resolve.ts";
import type { ApiKeyCredential, AuthContext, AuthOperationOptions, CredentialStore } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { recordFetch } from "./anthropic-utils.ts";

const signal = new AbortController().signal;

function envContext(env: Record<string, string | undefined>): AuthContext {
	return { env: async (name) => env[name], fileExists: async () => false };
}

async function storedKey(key: string): Promise<InMemoryCredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify("anthropic", async () => ({ type: "api_key", key }));
	return store;
}

async function storedSubscription(access: string): Promise<InMemoryCredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify("anthropic", async () => ({
		type: "oauth",
		access,
		refresh: "refresh-token",
		expires: Date.now() + 3_600_000,
	}));
	return store;
}

const GATEWAY_ENV = {
	ANTHROPIC_BASE_URL: "https://gateway.example",
	ANTHROPIC_CUSTOM_HEADERS: "x-case: one",
};
const GATEWAY_AUTH = { baseUrl: "https://gateway.example", headers: { "x-case": "one" } };

describe("provider environment at auth resolution", () => {
	it("applies the environment on top of a stored credential", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			await storedKey("stored-key"),
			envContext(GATEWAY_ENV),
			{ signal },
		);

		expect(result?.auth).toEqual({ apiKey: "stored-key", ...GATEWAY_AUTH });
	});

	it("applies the environment on top of an --api-key override", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			new InMemoryCredentialStore(),
			envContext(GATEWAY_ENV),
			{ apiKey: "override-key", signal },
		);

		expect(result?.auth).toEqual({ apiKey: "override-key", ...GATEWAY_AUTH });
	});

	it("applies the environment on top of an ambient API key", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			new InMemoryCredentialStore(),
			envContext({ ...GATEWAY_ENV, ANTHROPIC_API_KEY: "env-key" }),
			{ signal },
		);

		expect(result?.auth).toEqual({ apiKey: "env-key", ...GATEWAY_AUTH });
		expect(result?.source).toBe("ANTHROPIC_API_KEY");
	});

	it("keeps the ANTHROPIC_AUTH_TOKEN bearer over a custom authorization header", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			new InMemoryCredentialStore(),
			envContext({ ANTHROPIC_AUTH_TOKEN: "case-bearer", ANTHROPIC_CUSTOM_HEADERS: "authorization: Bearer custom" }),
			{ signal },
		);

		expect(result?.auth.headers).toEqual({ Authorization: "Bearer case-bearer" });
	});

	it("adds nothing when the environment names no endpoint", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			new InMemoryCredentialStore(),
			envContext({ ANTHROPIC_API_KEY: "env-key" }),
			{ signal },
		);

		expect(result).toEqual({ auth: { apiKey: "env-key" }, source: "ANTHROPIC_API_KEY", sourceKind: "environment" });
	});

	it("configures the provider from custom headers alone", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			new InMemoryCredentialStore(),
			envContext({ ANTHROPIC_CUSTOM_HEADERS: "x-api-key: header-key" }),
			{ signal },
		);

		expect(result).toEqual({ auth: { headers: { "x-api-key": "header-key" } }, source: "environment" });
	});

	it("keeps the environment endpoint when custom headers are the only credential", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			new InMemoryCredentialStore(),
			envContext({ ...GATEWAY_ENV, ANTHROPIC_CUSTOM_HEADERS: "x-api-key: header-key" }),
			{ signal },
		);

		expect(result).toEqual({
			auth: { baseUrl: "https://gateway.example", headers: { "x-api-key": "header-key" } },
			source: "environment",
		});
	});

	it("reads an env bearer before a stored subscription", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			await storedSubscription("sk-ant-oat01-stored"),
			envContext({ ANTHROPIC_AUTH_TOKEN: "env-bearer" }),
			{ signal },
		);

		expect(result?.auth).toEqual({ headers: { Authorization: "Bearer env-bearer" } });
		expect(result?.source).toBe("ANTHROPIC_AUTH_TOKEN");
	});

	it("reads an env key before a stored subscription", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			await storedSubscription("sk-ant-oat01-stored"),
			envContext({ ANTHROPIC_API_KEY: "env-key" }),
			{ signal },
		);

		expect(result?.auth).toEqual({ apiKey: "env-key" });
		expect(result?.source).toBe("ANTHROPIC_API_KEY");
	});

	it("still accepts ANTHROPIC_OAUTH_TOKEN when no credential is stored", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			new InMemoryCredentialStore(),
			envContext({ ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat01-env" }),
			{ signal },
		);

		expect(result?.auth.apiKey).toBe("sk-ant-oat01-env");
	});

	it("keeps a stored subscription over ANTHROPIC_OAUTH_TOKEN", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			await storedSubscription("sk-ant-oat01-stored"),
			envContext({ ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat01-env" }),
			{ signal },
		);

		expect(result?.auth.apiKey).toBe("sk-ant-oat01-stored");
		expect(result?.source).toBe("OAuth");
	});

	it("sends the environment API key rather than an OAuth token with a stored key", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			await storedKey("stored-key"),
			envContext({ ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat01-env", ANTHROPIC_API_KEY: "env-key" }),
			{ signal },
		);

		expect(result?.auth.apiKey).toBe("env-key");
		expect(result?.sourceKind).toBe("environment");
	});

	it("keeps a stored api key over ANTHROPIC_OAUTH_TOKEN", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			await storedKey("stored-key"),
			envContext({ ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat01-env" }),
			{ signal },
		);

		expect(result?.auth.apiKey).toBe("stored-key");
		expect(result?.source).toBe("stored credential");
	});

	it("trusts a typed source kind over the display label", async () => {
		const store = new InMemoryCredentialStore();
		await store.modify("labeled", async () => ({ type: "api_key", key: "stored-key" }));
		const labeled = {
			id: "labeled",
			auth: {
				environmentFirst: true,
				apiKey: {
					name: "Labeled key",
					resolve: async ({ credential }: { credential?: ApiKeyCredential }) =>
						credential?.key
							? {
									auth: { apiKey: credential.key },
									source: "renamed stored label",
									sourceKind: "stored" as const,
								}
							: {
									auth: { apiKey: "models-json-key" },
									source: "renamed configured label",
									sourceKind: "configured" as const,
								},
				},
			},
		};

		const storedWins = await resolveProviderAuth(labeled, store, envContext({}), { signal });
		expect(storedWins?.auth.apiKey).toBe("stored-key");

		const preempts = {
			id: "labeled",
			auth: {
				environmentFirst: true,
				apiKey: {
					name: "Labeled key",
					resolve: async () => ({
						auth: { apiKey: "env-key" },
						source: "stored credential",
						sourceKind: "environment" as const,
					}),
				},
			},
		};
		const envWins = await resolveProviderAuth(preempts, store, envContext({}), { signal });
		expect(envWins?.auth.apiKey).toBe("env-key");
	});

	it("reads an env bearer before a stored api key", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			await storedKey("stored-key"),
			envContext({ ANTHROPIC_AUTH_TOKEN: "env-bearer" }),
			{ signal },
		);

		expect(result?.auth).toEqual({ headers: { Authorization: "Bearer env-bearer" } });
		expect(result?.source).toBe("ANTHROPIC_AUTH_TOKEN");
	});

	it("lets workload identity federation outrank a stored credential, because it is ambient too", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			await storedKey("stored-key"),
			envContext({
				ANTHROPIC_FEDERATION_RULE_ID: "fdrl_test",
				ANTHROPIC_ORGANIZATION_ID: "org-test",
				ANTHROPIC_IDENTITY_TOKEN_FILE: "/nonexistent/identity.jwt",
			}),
			{ signal },
		);

		expect(result?.source).toBe("workload identity federation");
		expect(result?.auth.apiKey).toBeUndefined();
	});

	it("sends the bearer and the key when both env credentials are set", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			new InMemoryCredentialStore(),
			envContext({ ANTHROPIC_AUTH_TOKEN: "env-bearer", ANTHROPIC_API_KEY: "env-key" }),
			{ signal },
		);

		expect(result?.auth).toEqual({ apiKey: "env-key", headers: { Authorization: "Bearer env-bearer" } });
	});

	it("keeps an explicit --api-key above the environment", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			new InMemoryCredentialStore(),
			envContext({ ANTHROPIC_AUTH_TOKEN: "env-bearer", ANTHROPIC_API_KEY: "env-key" }),
			{ apiKey: "override-key", signal },
		);

		expect(result?.auth).toEqual({ apiKey: "override-key" });
	});

	it("never reads a stored credential when the environment answers", async () => {
		const inner = await storedSubscription("sk-ant-oat01-stored");
		let reads = 0;
		const counted = {
			read: async (providerId: string, options?: AuthOperationOptions) => {
				reads += 1;
				return inner.read(providerId, options);
			},
			list: inner.list.bind(inner),
			modify: inner.modify.bind(inner),
			delete: inner.delete.bind(inner),
		} satisfies CredentialStore;
		const result = await resolveProviderAuth(
			anthropicProvider(),
			counted,
			envContext({ ANTHROPIC_AUTH_TOKEN: "env-bearer" }),
			{ signal },
		);

		expect(result?.auth).toEqual({ headers: { Authorization: "Bearer env-bearer" } });
		expect(reads).toBe(0);
	});

	it("leaves a stored subscription in charge when the environment names no credential", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			await storedSubscription("sk-ant-oat01-stored"),
			envContext({}),
			{ signal },
		);

		expect(result?.auth).toEqual({ apiKey: "sk-ant-oat01-stored" });
		expect(result?.source).toBe("OAuth");
	});

	it("leaves another provider's stored credential in charge, which is the default order", async () => {
		const other = {
			id: "other",
			auth: {
				apiKey: {
					name: "Other API key",
					resolve: async ({ ctx, credential }: { ctx: AuthContext; credential?: ApiKeyCredential }) => {
						if (credential?.key) return { auth: { apiKey: credential.key }, source: "stored credential" };
						const key = await ctx.env("OTHER_API_KEY");
						return key ? { auth: { apiKey: key }, source: "OTHER_API_KEY" } : undefined;
					},
				},
			},
		};
		const store = new InMemoryCredentialStore();
		await store.modify("other", async () => ({ type: "api_key", key: "stored-key" }));
		const result = await resolveProviderAuth(other, store, envContext({ OTHER_API_KEY: "env-key" }), { signal });

		expect(result?.auth).toEqual({ apiKey: "stored-key" });
	});

	it("stays unconfigured for custom headers that carry no request auth", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			new InMemoryCredentialStore(),
			envContext({ ANTHROPIC_CUSTOM_HEADERS: "x-trace: 1" }),
			{ signal },
		);

		expect(result).toBeUndefined();
	});
});

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

const transcript = normalizeContext({
	systemPrompt: "System prompt.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
});

describe("custom headers on the wire", () => {
	it("lets a custom x-api-key override the key-derived one", async () => {
		const recorder = recordFetch(() => sseResponse());
		const models = createModels({
			authContext: envContext({ ANTHROPIC_API_KEY: "env-key", ANTHROPIC_CUSTOM_HEADERS: "x-api-key: header-key" }),
		});
		models.setProvider(anthropicProvider());

		await models.streamSimple(anthropicModel, transcript, { fetch: recorder.fetch }).result();

		expect(recorder.requests).toHaveLength(1);
		expect(recorder.requests[0].headers.get("x-api-key")).toBe("header-key");
	});

	it("sends a header credential to the environment endpoint", async () => {
		const recorder = recordFetch(() => sseResponse());
		const models = createModels({
			authContext: envContext({
				ANTHROPIC_BASE_URL: "https://gateway.example",
				ANTHROPIC_CUSTOM_HEADERS: "x-api-key: header-key",
			}),
		});
		models.setProvider(anthropicProvider());

		await models.streamSimple(anthropicModel, transcript, { fetch: recorder.fetch }).result();

		expect(recorder.requests).toHaveLength(1);
		expect(recorder.requests[0].url.origin).toBe("https://gateway.example");
		expect(recorder.requests[0].headers.get("x-api-key")).toBe("header-key");
	});

	it("lets a custom anthropic-version override the transport default", async () => {
		const recorder = recordFetch(() => sseResponse());

		await streamAnthropic(anthropicModel, transcript, {
			apiKey: "key",
			headers: { "anthropic-version": "2024-01-01" },
			fetch: recorder.fetch,
		}).result();

		expect(recorder.requests[0].headers.get("anthropic-version")).toBe("2024-01-01");
	});
});
