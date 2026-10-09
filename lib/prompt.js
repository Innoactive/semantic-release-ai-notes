const MAX_COMMIT_CHARS = 2_000;
// Pull request descriptions share one budget (~30k tokens), so a release with a few PRs keeps
// them whole (impact sections tend to sit near the end) and a large one still fits the context.
const PR_BUDGET_CHARS = 120_000;
const MIN_PR_BODY_CHARS = 2_000;
const MAX_PR_BODY_CHARS = 16_000;

const SYSTEM = `You turn a software release's changelog into release notes for the people who install and use the software.

You get a description of the product and its readers, the changelog generated from conventional commits, the full commit messages, and the descriptions of the merged pull requests.

Write:
- One or two sentences on what this release means for its readers.
- Then the changes as bullet points under these headings, in this order, leaving out empty ones: "### Breaking changes", "### New", "### Improved", "### Fixed".

Rules:
- Every breaking change in the input appears under "Breaking changes", with what readers have to do about it.
- Describe what changed for the reader, not how the code changed.
- Merge entries that belong to the same change. A fix to something that is itself new in this release is part of that new feature, not a fix.
- Leave out changes readers cannot notice: refactoring, tests, CI, build scripts, internal tooling, review follow-ups. If nothing is left, write one sentence saying this is a maintenance release with no user-facing changes.
- State only what the input supports. Do not guess at causes, numbers or effects.
- Where the input ties a change to a pull request or issue, reference it as #123. Never include commit hashes.
- Leave out internal names, people, customers and ticket identifiers from pull request descriptions unless readers would recognize them.
- Do not repeat the version number or add a top-level heading.
- Reply with the markdown only.`;

/** System and user prompt asking a model to rewrite `notes`, with commits and pull requests as context. */
export function buildPrompt({ notes, pullRequests, product, instructions, context }) {
    const { commits, lastRelease, nextRelease } = context;
    const system = instructions ? `${SYSTEM}\n\nAdditional instructions for this project:\n${instructions}` : SYSTEM;

    const commitText = commits
        .map(({ hash, message }) => `--- ${hash.slice(0, 7)}\n${truncate(message.trim(), MAX_COMMIT_CHARS)}`)
        .join("\n\n");
    const perPr = Math.min(MAX_PR_BODY_CHARS, Math.max(MIN_PR_BODY_CHARS, Math.floor(PR_BUDGET_CHARS / pullRequests.length)));
    const prText = pullRequests.length
        ? pullRequests
              .map(({ number, title, body }) => `--- #${number}: ${title}\n${truncate(cleanBody(body), perPr)}`)
              .join("\n\n")
        : "(none found)";

    const user = `# Product and readers
${product || "Not described; infer it from the changes."}

# Version
${nextRelease.version}${lastRelease?.version ? ` (previous: ${lastRelease.version})` : " (first release)"}

# Generated changelog
${notes.trim()}

# Commits
${commitText}

# Pull requests
${prText}`;

    return { system, user };
}

// PR templates leave HTML comments behind; they are instructions to the author, not content.
function cleanBody(body) {
    return body.replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim() || "(no description)";
}

function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}
