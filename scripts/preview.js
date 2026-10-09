// Shows what the plugin would publish for a past release, without releasing anything.
//
//   GITHUB_TOKEN=$(gh auth token) OPENAI_API_KEY=<key> \
//     node scripts/preview.js <repo-dir> <from-tag> <to-tag> [--provider <name>] [--model <id>] [--product <text>] [--instructions <text>] [--prompt]
//
// ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN work in place of OPENAI_API_KEY, as in a release.
// Options come from the repo's JSON .releaserc (this plugin's entry, or the standard notes
// generator's) and are overridden by the flags. --prompt prints what would be sent to the model
// instead of calling it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { generateNotes as generateStandardNotes } from "@semantic-release/release-notes-generator";
import { generateNotes } from "../index.js";
import { fetchPullRequests } from "../lib/github.js";
import { buildPrompt } from "../lib/prompt.js";

const NOTES_PLUGINS = ["@innoactive/semantic-release-ai-notes", "@semantic-release/release-notes-generator"];

const { values: flags, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        provider: { type: "string" },
        model: { type: "string" },
        product: { type: "string" },
        instructions: { type: "string" },
        prompt: { type: "boolean" },
    },
});
const [cwd, from, to] = positionals;
if (!to) {
    console.error("Usage: node scripts/preview.js <repo-dir> <from-tag> <to-tag> [--provider <name>] [--model <id>] [--product <text>] [--instructions <text>] [--prompt]");
    process.exit(1);
}

const git = (...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const commits = git("log", "--format=%H%x1f%B%x1e", `${from}..${to}`)
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
        const [hash, message] = entry.split("\x1f");
        return { hash, message };
    });

const { prompt, ...overrides } = flags;
const pluginConfig = { preset: "conventionalcommits", ...readNotesConfig(cwd), ...overrides };
const context = {
    cwd,
    env: process.env,
    logger: { log: console.error, warn: (message) => console.error(`warning: ${message}`), error: console.error },
    options: { repositoryUrl: git("remote", "get-url", "origin") },
    lastRelease: { version: from.replace(/^v/, ""), gitTag: from, gitHead: git("rev-list", "-1", from) },
    nextRelease: { version: to.replace(/^v/, ""), gitTag: to, gitHead: git("rev-list", "-1", to) },
    commits,
};

if (prompt) {
    const notes = await generateStandardNotes(pluginConfig, context);
    const pullRequests = await fetchPullRequests(context);
    const { system, user } = buildPrompt({ ...pluginConfig, notes, pullRequests, context });
    console.log(`===== system\n${system}\n\n===== user\n${user}`);
} else {
    console.log(await generateNotes(pluginConfig, context));
}

// Only JSON configs are read; anything else (YAML, JS, package.json) falls back to the flags.
function readNotesConfig(dir) {
    for (const name of [".releaserc", ".releaserc.json"]) {
        try {
            const { plugins = [] } = JSON.parse(readFileSync(join(dir, name), "utf8"));
            const entry = plugins.find((plugin) => NOTES_PLUGINS.includes(Array.isArray(plugin) ? plugin[0] : plugin));
            if (entry) {
                return Array.isArray(entry) ? entry[1] ?? {} : {};
            }
        } catch {
            // missing or not JSON
        }
    }
    return {};
}
