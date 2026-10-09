import { complete as anthropic } from "./anthropic.js";
import { complete as claudeCode } from "./claude-code.js";
import { complete as openai } from "./openai.js";

// Without a `provider` option, the first one whose credential is set is used, in this order.
export const PROVIDERS = {
    openai: {
        credential: "OPENAI_API_KEY",
        model: "gpt-5.4-mini",
        complete: ({ credential, env, ...rest }) => openai({ apiKey: credential, baseUrl: env.OPENAI_BASE_URL, ...rest }),
    },
    anthropic: {
        credential: "ANTHROPIC_API_KEY",
        model: "claude-opus-5-5",
        complete: ({ credential, env, ...rest }) => anthropic({ apiKey: credential, baseUrl: env.ANTHROPIC_BASE_URL, ...rest }),
    },
    "claude-code": {
        credential: "CLAUDE_CODE_OAUTH_TOKEN",
        model: "claude-opus-5-5",
        complete: ({ credential, env, ...rest }) => claudeCode({ token: credential, env, ...rest }),
    },
};

/**
 * The provider to use and how to call it, or a `reason` why there is none. An explicitly
 * configured provider is used only when its own credential is set.
 */
export function selectProvider({ provider, model }, env) {
    if (provider && !PROVIDERS[provider]) {
        return { reason: `unknown provider "${provider}", expected one of ${Object.keys(PROVIDERS).join(", ")}` };
    }
    const name = provider ?? Object.keys(PROVIDERS).find((key) => env[PROVIDERS[key].credential]);
    if (!name) {
        return { reason: `none of ${Object.values(PROVIDERS).map((p) => p.credential).join(", ")} is set` };
    }
    const { credential, model: defaultModel, complete } = PROVIDERS[name];
    if (!env[credential]) {
        return { reason: `provider "${name}" needs ${credential}, which is not set` };
    }
    const resolvedModel = model ?? defaultModel;
    return {
        name,
        model: resolvedModel,
        complete: (prompt) => complete({ credential: env[credential], env, model: resolvedModel, ...prompt }),
    };
}
