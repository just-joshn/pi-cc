import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadAnthropicOAuth } from "../auth/oauth/load.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import {
	ANTHROPIC_API_KEY_ENV,
	ANTHROPIC_AUTH_TOKEN_ENV,
	ANTHROPIC_FEDERATION_RULE_ID_ENV,
	ANTHROPIC_IDENTITY_TOKEN_FILE_ENV,
	ANTHROPIC_OAUTH_TOKEN_ENV,
	ANTHROPIC_ORGANIZATION_ID_ENV,
	ANTHROPIC_SERVICE_ACCOUNT_ID_ENV,
	ANTHROPIC_WORKSPACE_ID_ENV,
} from "../env-api-keys.ts";
import { createProvider, type Provider } from "../models.ts";
import type { ProviderEnv } from "../types.ts";
import { ANTHROPIC_MODELS } from "./anthropic.models.ts";
import { readAnthropicEnvironment } from "./anthropic-env.ts";

function anthropicApiKeyAuth(): ApiKeyAuth {
	return {
		name: "Anthropic API key",
		login: async (interaction) => {
			interaction.signal.throwIfAborted();
			const key = await interaction.prompt({ type: "secret", message: "Enter Anthropic API key" });
			interaction.signal.throwIfAborted();
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential, signal }) => {
			signal.throwIfAborted();
			if (credential?.key) {
				return {
					auth: { apiKey: credential.key },
					env: credential.env,
					source: "stored credential",
					sourceKind: "stored",
				};
			}

			const authToken = await ctx.env(ANTHROPIC_AUTH_TOKEN_ENV);
			signal.throwIfAborted();
			const bearer = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
			const apiKey = await ctx.env(ANTHROPIC_API_KEY_ENV);
			signal.throwIfAborted();
			if (apiKey || bearer) {
				return {
					auth: { ...(apiKey ? { apiKey } : {}), ...(bearer ? { headers: bearer } : {}) },
					source: bearer ? ANTHROPIC_AUTH_TOKEN_ENV : ANTHROPIC_API_KEY_ENV,
					sourceKind: "environment",
				};
			}
			const oauthToken = await ctx.env(ANTHROPIC_OAUTH_TOKEN_ENV);
			signal.throwIfAborted();

			// Federation beats the pi-only OAuth fallback. Its ids travel in `env` rather than auth.
			const federation: ProviderEnv = {};
			for (const envVar of [
				ANTHROPIC_FEDERATION_RULE_ID_ENV,
				ANTHROPIC_ORGANIZATION_ID_ENV,
				ANTHROPIC_IDENTITY_TOKEN_FILE_ENV,
			]) {
				const value = await ctx.env(envVar);
				signal.throwIfAborted();
				if (!value) {
					return oauthToken
						? { auth: { apiKey: oauthToken }, source: ANTHROPIC_OAUTH_TOKEN_ENV, sourceKind: "oauth-token" }
						: undefined;
				}
				federation[envVar] = value;
			}
			for (const envVar of [ANTHROPIC_SERVICE_ACCOUNT_ID_ENV, ANTHROPIC_WORKSPACE_ID_ENV]) {
				const value = await ctx.env(envVar);
				signal.throwIfAborted();
				if (value) federation[envVar] = value;
			}
			return {
				auth: {},
				env: federation,
				source: "workload identity federation",
				sourceKind: "environment",
			};
		},
	};
}

export function anthropicProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "anthropic",
		name: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		auth: {
			apiKey: anthropicApiKeyAuth(),
			oauth: lazyOAuth({
				name: "Anthropic (Claude Pro/Max)",
				isSubscription: true,
				load: loadAnthropicOAuth,
			}),
			environment: readAnthropicEnvironment,
			// An auth token or an API key disables a stored credential. ANTHROPIC_OAUTH_TOKEN does not.
			environmentFirst: true,
		},
		models: Object.values(ANTHROPIC_MODELS),
		api: anthropicMessagesApi(),
	});
}
