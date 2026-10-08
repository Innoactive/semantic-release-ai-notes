const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const TIMEOUT_MS = 120_000;

/** Sends one Chat Completions request and returns the reply text. Throws on any failure. */
export async function complete({ apiKey, baseUrl = DEFAULT_BASE_URL, model, system, user }) {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            model,
            messages: [
                { role: "system", content: system },
                { role: "user", content: user },
            ],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`OpenAI API returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }

    const text = (await response.json()).choices?.[0]?.message?.content?.trim();
    if (!text) {
        throw new Error("OpenAI API returned an empty reply");
    }
    return text;
}
