import { generateNotes as generateStandardNotes } from "@semantic-release/release-notes-generator";
import { fetchPullRequests } from "./lib/github.js";
import { buildPrompt } from "./lib/prompt.js";
import { selectProvider } from "./lib/providers.js";

// semantic-release generates the notes again when a prepare step commits (@semantic-release/git
// does), so one release asks twice. Answering from the first call keeps one model call per
// release and the published text identical to what was logged.
const rewritten = new Map();

/**
 * Drop-in replacement for @semantic-release/release-notes-generator: generates the standard
 * notes with the same options, then puts a model-written summary above them. The standard
 * list is kept in a collapsed block, and is returned unchanged whenever the rewrite cannot run.
 */
export async function generateNotes(pluginConfig, context) {
    const { provider: providerName, model, product, instructions, ...standardConfig } = pluginConfig;
    const { env, logger } = context;

    const notes = await generateStandardNotes(standardConfig, context);
    if (!notes.trim()) {
        return notes;
    }
    const provider = selectProvider({ provider: providerName, model }, env);
    if (!provider.complete) {
        logger.log(`Keeping the standard release notes: ${provider.reason}`);
        return notes;
    }
    if (rewritten.has(notes)) {
        return rewritten.get(notes);
    }

    try {
        const pullRequests = await fetchPullRequests(context);
        const summary = await provider.complete(buildPrompt({ notes, pullRequests, product, instructions, context }));
        const result = compose(notes, summary);
        rewritten.set(notes, result);
        logger.log(
            `Rewrote the release notes with ${provider.name} (${provider.model}), ${pullRequests.length} pull request(s) as context`,
        );
        return result;
    } catch (error) {
        logger.warn(`Could not rewrite the release notes, keeping the standard ones: ${error.message}`);
        return notes;
    }
}

// The version heading stays on top. The standard list moves into a collapsed block, so readers
// and tools that want the commit-level detail and links still find it.
export function compose(notes, summary) {
    const [first, ...rest] = notes.trim().split("\n");
    const hasHeading = /^#{1,3} /.test(first);
    const heading = hasHeading ? `${first}\n\n` : "";
    const list = (hasHeading ? rest.join("\n") : notes).trim();
    const details = list ? `\n\n<details>\n<summary>All changes</summary>\n\n${list}\n\n</details>` : "";
    return `${heading}${summary.trim()}${details}\n`;
}
