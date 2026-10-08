import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const TIMEOUT_MS = 300_000;

// Credentials Claude Code prefers over CLAUDE_CODE_OAUTH_TOKEN. They are removed from the child's
// environment so the token is what gets used.
const OVERRIDING_ENV = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
];

/**
 * Runs the Claude Code CLI headless with a Claude subscription's OAuth token (`claude setup-token`)
 * and returns the reply text. The Messages API does not accept that token; Claude Code does.
 * Throws on any failure.
 */
export async function complete({ token, env, model, system, user, executable = findClaudeCode() }) {
    // An empty directory, so no CLAUDE.md, settings, hooks or MCP servers from the repository apply.
    const cwd = await mkdtemp(join(tmpdir(), "ai-notes-"));
    const childEnv = {
        ...env,
        CLAUDE_CODE_OAUTH_TOKEN: token,
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
    for (const name of OVERRIDING_ENV) {
        delete childEnv[name];
    }

    const [command, ...prefix] = executable;
    const args = [
        ...prefix,
        "--print",
        "--model", model,
        "--system-prompt", system,
        "--tools", "",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--max-turns", "2",
        "--output-format", "json",
    ];
    let stdout;
    try {
        stdout = await run(command, args, { cwd, env: childEnv, input: user });
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }

    let result;
    try {
        result = JSON.parse(stdout);
    } catch {
        throw new Error(`Claude Code printed no JSON result: ${stdout.slice(0, 300)}`);
    }
    // Some failures, such as an expired token, come back with exit code 0 and subtype "success";
    // is_error is the field that tells.
    if (result.is_error || result.subtype !== "success" || typeof result.result !== "string") {
        const detail = typeof result.result === "string" ? result.result : (result.errors ?? []).join("; ");
        throw new Error(`Claude Code failed (${result.subtype}): ${detail.slice(0, 300)}`);
    }
    const text = result.result.trim();
    if (!text) {
        throw new Error("Claude Code returned an empty reply");
    }
    return text;
}

// An @anthropic-ai/claude-code installed next to this plugin (for example as another semantic-release
// extra plugin), else `claude` on PATH.
function findClaudeCode() {
    try {
        const manifest = createRequire(import.meta.url).resolve("@anthropic-ai/claude-code/package.json");
        const { bin } = JSON.parse(readFileSync(manifest, "utf8"));
        return [join(dirname(manifest), typeof bin === "string" ? bin : bin.claude)];
    } catch {
        return ["claude"];
    }
}

function run(command, args, { cwd, env, input }) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env, windowsHide: true });
        // Not spawn's own `timeout`: its timer is only cleared on exit, which a command that
        // failed to start never emits, so it would hold the release for the full timeout.
        const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(
                error.code === "ENOENT"
                    ? new Error("Claude Code is not installed: add @anthropic-ai/claude-code next to this plugin, or put claude on PATH")
                    : error,
            );
        });
        child.on("close", (code, signal) => {
            clearTimeout(timer);
            if (signal) {
                reject(new Error(`Claude Code was stopped by ${signal}, after at most ${TIMEOUT_MS / 1000}s`));
            } else if (code !== 0 && !stdout.trim()) {
                reject(new Error(`Claude Code exited with ${code}: ${stderr.trim().slice(0, 300)}`));
            } else {
                // A failed run can still print its JSON result, which carries the reason.
                resolve(stdout);
            }
        });
        // The child may exit before reading all of its input; that surfaces through `close`.
        child.stdin.on("error", () => {});
        child.stdin.end(input);
    });
}
