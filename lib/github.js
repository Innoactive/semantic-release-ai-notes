const CONCURRENCY = 8;

/**
 * Looks up the merged pull requests behind the release's commits. Pull request descriptions say
 * why a change was made, which commit subjects rarely do. This context is optional: any failure
 * is logged and yields an empty list rather than stopping the rewrite.
 */
export async function fetchPullRequests({ commits, options, env, logger }) {
    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    const repo = parseRepositoryUrl(options.repositoryUrl);
    if (!token || !repo) {
        return [];
    }

    const api = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
    const byNumber = new Map();
    try {
        await forEachLimited(commits, CONCURRENCY, async ({ hash }) => {
            const response = await fetch(`${api}/repos/${repo.owner}/${repo.name}/commits/${hash}/pulls`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            });
            if (!response.ok) {
                throw new Error(`GitHub API returned ${response.status} for commit ${hash}`);
            }
            for (const pr of await response.json()) {
                if (pr.merged_at) {
                    byNumber.set(pr.number, { number: pr.number, title: pr.title, body: pr.body ?? "" });
                }
            }
        });
    } catch (error) {
        logger.warn(`Could not look up pull requests, continuing without them: ${error.message}`);
        return [];
    }
    return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/** Owner and name from an https, ssh or scp-style git URL; `undefined` when there is no such path. */
export function parseRepositoryUrl(url = "") {
    const match = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
    return match ? { owner: match[1], name: match[2] } : undefined;
}

async function forEachLimited(items, limit, fn) {
    const queue = [...items];
    const worker = async () => {
        while (queue.length) {
            await fn(queue.shift());
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}
