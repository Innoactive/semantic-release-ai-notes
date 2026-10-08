import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { compose, generateNotes } from "../index.js";
import { existsSync } from "node:fs";
import { parseRepositoryUrl } from "../lib/github.js";
import { selectProvider } from "../lib/providers.js";

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

// Each test uses its own version: the plugin caches rewrites by the standard notes, and the
// version is part of their heading.
function makeContext(version, env = { OPENAI_API_KEY: "sk-test", GITHUB_TOKEN: "gh-test" }) {
    const logs = [];
    const warnings = [];
    return {
        logs,
        warnings,
        cwd: process.cwd(),
        env,
        logger: { log: (message) => logs.push(message), warn: (message) => warnings.push(message), error() {} },
        options: { repositoryUrl: "https://github.com/acme/widget.git" },
        lastRelease: { version: "1.0.0", gitTag: "v1.0.0", gitHead: "a".repeat(40) },
        nextRelease: { version, gitTag: `v${version}`, gitHead: "b".repeat(40) },
        commits: [
            { hash: "1".repeat(40), message: "feat(ports): reserve the streaming port\n\nAvoids Windows exclusions." },
            { hash: "2".repeat(40), message: "fix(ports): handle the opt-out" },
        ],
    };
}

// A Messages API streaming response carrying `text`.
function anthropicStream(text, stopReason = "end_turn") {
    const events = [
        ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } }],
        ["message_stop", { type: "message_stop" }],
    ];
    const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

// Routes GitHub, OpenAI and Anthropic requests to canned responses and records what was sent.
function mockFetch({ pulls = [], openai = { status: 200, text: "Ports are now reserved." }, anthropic = { text: "Claude summary." } } = {}) {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
        const href = String(url);
        calls.push({ url: href, headers: new Headers(init.headers), body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
        if (href.includes("/pulls")) {
            return Response.json(pulls);
        }
        if (href.includes("/v1/messages")) {
            return anthropicStream(anthropic.text, anthropic.stopReason);
        }
        if (openai.status !== 200) {
            return new Response("upstream error", { status: openai.status });
        }
        return Response.json({ choices: [{ message: { content: openai.text } }] });
    };
    return calls;
}

const modelCalls = (calls) => calls.filter((call) => /\/chat\/completions|\/v1\/messages/.test(call.url));
const config = { preset: "conventionalcommits", product: "Widget: a desktop app for IT admins." };

test("keeps the standard notes when no credential is set", async () => {
    const calls = mockFetch();
    const context = makeContext("1.1.0", {});
    const notes = await generateNotes(config, context);

    assert.match(notes, /reserve the streaming port/);
    assert.doesNotMatch(notes, /<details>/);
    assert.equal(calls.length, 0);
    assert.match(context.logs[0], /none of OPENAI_API_KEY, ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN is set/);
});

test("puts the summary under the version heading and keeps the standard list collapsed", async () => {
    const calls = mockFetch({
        pulls: [{ number: 42, title: "Reserve ports", body: "<!-- template -->Why: exclusions.", merged_at: "2026-01-01" }],
    });
    const context = makeContext("1.2.0");
    const notes = await generateNotes(config, context);

    assert.match(notes.split("\n")[0], /^## \[1\.2\.0\]/);
    assert.match(notes, /Ports are now reserved\.\n\n<details>\n<summary>All changes<\/summary>/);
    assert.match(notes, /<\/details>\n$/);
    assert.match(notes, /\* \*\*ports:\*\* reserve the streaming port/);
    assert.deepEqual(context.warnings, []);

    const request = calls.find((call) => call.url.endsWith("/chat/completions")).body;
    assert.equal(request.model, "gpt-5.4-mini");
    const prompt = request.messages[1].content;
    assert.match(prompt, /Widget: a desktop app for IT admins\./);
    assert.match(prompt, /#42: Reserve ports\nWhy: exclusions\./);
    assert.match(prompt, /Avoids Windows exclusions\./);
    assert.ok(calls.some((call) => call.url === `https://api.github.com/repos/acme/widget/commits/${"1".repeat(40)}/pulls`));
});

test("asks the model once when semantic-release generates the same notes again", async () => {
    const calls = mockFetch();
    const first = await generateNotes(config, makeContext("1.3.0"));
    const second = await generateNotes(config, makeContext("1.3.0"));

    assert.equal(second, first);
    assert.equal(modelCalls(calls).length, 1);
});

test("keeps the standard notes when the model call fails", async () => {
    mockFetch({ openai: { status: 500 } });
    const context = makeContext("1.4.0");
    const notes = await generateNotes(config, context);

    assert.doesNotMatch(notes, /<details>/);
    assert.match(notes, /reserve the streaming port/);
    assert.match(context.warnings[0], /OpenAI API returned 500/);
});

test("rewrites without pull requests when GitHub cannot be reached", async () => {
    globalThis.fetch = async (url) =>
        String(url).includes("/pulls")
            ? new Response("forbidden", { status: 403 })
            : Response.json({ choices: [{ message: { content: "Summary." } }] });
    const context = makeContext("1.5.0");
    const notes = await generateNotes(config, context);

    assert.match(notes, /Summary\.\n\n<details>/);
    assert.match(context.warnings[0], /continuing without them/);
});

test("passes the project instructions and model through", async () => {
    const calls = mockFetch();
    await generateNotes({ ...config, model: "gpt-test", instructions: "Call out firewall changes." }, makeContext("1.6.0"));

    const request = modelCalls(calls)[0].body;
    assert.equal(request.model, "gpt-test");
    assert.match(request.messages[0].content, /Call out firewall changes\.$/);
});

test("uses Claude through the Anthropic API when ANTHROPIC_API_KEY is the credential", async () => {
    const calls = mockFetch();
    const notes = await generateNotes(config, makeContext("1.7.0", { ANTHROPIC_API_KEY: "sk-ant-test" }));

    assert.match(notes, /Claude summary\.\n\n<details>/);
    const [call] = modelCalls(calls);
    assert.equal(call.url, "https://api.anthropic.com/v1/messages?beta=true");
    assert.equal(call.headers.get("x-api-key"), "sk-ant-test");
    assert.match(call.headers.get("anthropic-beta"), /server-side-fallback-2026-07-01/);
    assert.equal(call.body.model, "claude-opus-5-5");
    assert.equal(call.body.fallbacks, "default");
    assert.deepEqual(call.body.thinking, { type: "adaptive" });
    assert.equal(call.body.stream, true);
    assert.match(call.body.system, /^You turn a software release's changelog/);
    assert.match(call.body.messages[0].content, /Widget: a desktop app for IT admins\./);
});

test("an explicit provider wins over the default order", async () => {
    const calls = mockFetch();
    await generateNotes({ ...config, provider: "anthropic" }, makeContext("1.8.0", { OPENAI_API_KEY: "sk", ANTHROPIC_API_KEY: "sk-ant" }));

    assert.deepEqual(modelCalls(calls).map((call) => new URL(call.url).host), ["api.anthropic.com"]);
});

test("keeps the standard notes when the configured provider has no credential, or is unknown", async () => {
    const calls = mockFetch();
    const missing = makeContext("1.9.0", { OPENAI_API_KEY: "sk" });
    const unknown = makeContext("1.9.1", { OPENAI_API_KEY: "sk" });
    await generateNotes({ ...config, provider: "claude-code" }, missing);
    await generateNotes({ ...config, provider: "gemini" }, unknown);

    assert.equal(modelCalls(calls).length, 0);
    assert.match(missing.logs[0], /provider "claude-code" needs CLAUDE_CODE_OAUTH_TOKEN, which is not set/);
    assert.match(unknown.logs[0], /unknown provider "gemini", expected one of openai, anthropic, claude-code/);
});

test("keeps the standard notes when Claude declines", async () => {
    mockFetch({ anthropic: { text: "", stopReason: "refusal" } });
    const context = makeContext("1.10.0", { ANTHROPIC_API_KEY: "sk-ant" });
    const notes = await generateNotes(config, context);

    assert.doesNotMatch(notes, /<details>/);
    assert.match(context.warnings[0], /Claude declined/);
});

test("compose leaves out the collapsed block when the standard notes are only a heading", () => {
    assert.equal(compose("## [1.0.1](link) (2026-01-01)\n\n", "Maintenance release."), "## [1.0.1](link) (2026-01-01)\n\nMaintenance release.\n");
});

test("parses https, ssh and token-bearing repository URLs", () => {
    const expected = { owner: "acme", name: "widget" };
    assert.deepEqual(parseRepositoryUrl("https://github.com/acme/widget.git"), expected);
    assert.deepEqual(parseRepositoryUrl("git@github.com:acme/widget.git"), expected);
    assert.deepEqual(parseRepositoryUrl("https://x-access-token:secret@github.com/acme/widget"), expected);
    assert.deepEqual(parseRepositoryUrl("git+https://github.com/acme/widget.git"), expected);
    assert.equal(parseRepositoryUrl("not a url"), undefined);
});

const fakeClaude = [process.execPath, new URL("./fixtures/fake-claude.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")];
const claudeCodeProvider = (fake) =>
    selectProvider({ provider: "claude-code" }, { ...process.env, ANTHROPIC_API_KEY: "sk-ant-should-not-win", CLAUDE_CODE_OAUTH_TOKEN: "oauth-test", FAKE_CLAUDE: fake });

test("runs Claude Code headless with the OAuth token, from an empty directory", async () => {
    const reply = await claudeCodeProvider("echo").complete({ system: "System rules.", user: "The release input.", executable: fakeClaude });
    const seen = JSON.parse(reply);

    assert.equal(seen.input, "The release input.");
    assert.equal(seen.token, "oauth-test");
    assert.equal(seen.apiKey, null);
    assert.equal(seen.noClaudeMds, "1");
    assert.match(seen.cwd, /ai-notes-/);
    assert.equal(existsSync(seen.cwd), false);
    const flag = (name) => seen.args[seen.args.indexOf(name) + 1];
    assert.ok(seen.args.includes("--print"));
    assert.equal(flag("--model"), "claude-opus-5-5");
    assert.equal(flag("--system-prompt"), "System rules.");
    assert.equal(flag("--tools"), "");
    assert.equal(flag("--output-format"), "json");
});

test("treats a Claude Code result with is_error as a failure even when it exits 0", async () => {
    await assert.rejects(
        claudeCodeProvider("expired").complete({ system: "s", user: "u", executable: fakeClaude }),
        /Claude Code failed \(success\): Failed to authenticate: OAuth session expired/,
    );
});

test("reports a Claude Code crash and a missing CLI", async () => {
    await assert.rejects(claudeCodeProvider("crash").complete({ system: "s", user: "u", executable: fakeClaude }), /exited with 3: boom/);
    await assert.rejects(
        claudeCodeProvider("echo").complete({ system: "s", user: "u", executable: ["claude-not-installed-here"] }),
        /Claude Code is not installed/,
    );
});
