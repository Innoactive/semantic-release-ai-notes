import Anthropic from "@anthropic-ai/sdk";

const TIMEOUT_MS = 300_000;

// Models that accept Anthropic's server-side refusal fallback: a classifier decline is re-run on
// the model Anthropic recommends for that category instead of coming back as a refusal.
const SUPPORTS_FALLBACK = /^claude-(fable-5|opus-5|sonnet-5-5)/;

/** Sends one Messages API request with an Anthropic API key and returns the reply text. Throws on any failure. */
export async function complete({ apiKey, baseUrl, model, system, user }) {
    const client = new Anthropic({ apiKey, baseURL: baseUrl, timeout: TIMEOUT_MS });
    const fallback = SUPPORTS_FALLBACK.test(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {};

    // Streamed because the input can run to tens of thousands of tokens.
    const message = await client.beta.messages
        .stream({
            model,
            max_tokens: 16_000,
            thinking: { type: "adaptive" },
            output_config: { effort: "high" },
            system,
            messages: [{ role: "user", content: user }],
            ...fallback,
        })
        .finalMessage();

    if (message.stop_reason === "refusal") {
        throw new Error(`Claude declined to write the notes (${message.stop_details?.category ?? "no category"})`);
    }
    if (message.stop_reason === "max_tokens") {
        throw new Error("Claude ran out of output tokens before finishing the notes");
    }
    const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
    if (!text) {
        throw new Error("Claude returned an empty reply");
    }
    return text;
}
