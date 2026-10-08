# @innoactive/semantic-release-ai-notes

A [semantic-release](https://github.com/semantic-release/semantic-release) plugin that turns the generated changelog into release notes people want to read. It is a drop-in replacement for `@semantic-release/release-notes-generator`:

1. It generates the standard notes with the same options.
2. It sends them, the full commit messages and the descriptions of the merged pull requests to an OpenAI model or to Claude.
3. It publishes the model's summary under the version heading, and keeps the standard list in a collapsed **All changes** block.

The result has this shape (the summary text is illustrative):

```markdown
## [2.41.0](…/compare/v2.40.0...v2.41.0) (2026-10-06)

Spatial Runtime now reserves its ports so Windows can't hand them to Hyper-V, WSL2 or Docker.

### New
- The foveated streaming and REST ports are reserved at install and on every start … (#484)

<details>
<summary>All changes</summary>

### Features
* **foveated:** reserve the foveated TCP port against Windows dynamic exclusions ([f2fb022](…))
…
</details>
```

It never fails a release. Without a credential, when the standard notes are empty, or when the model call fails, it returns the standard notes unchanged and logs why.

## Usage

Replace the standard notes generator in your config. Its options (`preset`, `presetConfig`, `writerOpts`, …) work as before.

```json
{
  "plugins": [
    ["@semantic-release/commit-analyzer", { "preset": "conventionalcommits" }],
    [
      "@innoactive/semantic-release-ai-notes",
      {
        "preset": "conventionalcommits",
        "product": "Spatial Runtime: Windows tray app that streams OpenXR apps to Apple Vision Pro. Readers: customer IT admins and VRED users."
      }
    ],
    "@semantic-release/github"
  ]
}
```

The plugin uses whichever `@semantic-release/release-notes-generator` semantic-release itself has installed (a peer dependency), so presets and version pins behave as they did before.

### Options

| Option         | Default            | Description |
| -------------- | ------------------ | ----------- |
| `product`      | —                  | What the project is and who reads its release notes. The most useful option: it decides what counts as user-facing. |
| `instructions` | —                  | Extra rules for this project, appended to the prompt, e.g. `"Call out every port and firewall change."` |
| `provider`     | first with a credential | `openai`, `anthropic` or `claude-code`. See [Providers](#providers). |
| `model`        | per provider       | Model ID for the chosen provider. Set `provider` too when you set it, so the model and the credential match. |

Every other option is passed to the standard notes generator.

### Providers

Set the credential for one provider. Without a `provider` option the plugin uses the first one, in this order, whose credential is set:

| `provider`    | Credential                | Default model     | How it calls the model |
| ------------- | ------------------------- | ----------------- | ---------------------- |
| `openai`      | `OPENAI_API_KEY`          | `gpt-5.4-mini`    | Chat Completions API. `OPENAI_BASE_URL` points it at a compatible endpoint (proxy, gateway, Azure). |
| `anthropic`   | `ANTHROPIC_API_KEY`       | `claude-opus-5-5` | Messages API through the official SDK, with adaptive thinking and Anthropic's server-side refusal fallback. `ANTHROPIC_BASE_URL` overrides the endpoint. |
| `claude-code` | `CLAUDE_CODE_OAUTH_TOKEN` | `claude-opus-5-5` | Runs the Claude Code CLI headless. See [below](#claude-code-oauth-token). |

#### Claude Code OAuth token

`CLAUDE_CODE_OAUTH_TOKEN` is a Claude subscription token from `claude setup-token`, the one `anthropics/claude-code-action` takes as `claude_code_oauth_token`. The Messages API does not accept it; Claude Code does, so this provider runs `claude --print`:

- Install `@anthropic-ai/claude-code` next to the plugin (for example in the semantic-release action's extra plugins, with a pinned version), or put `claude` on `PATH`. Its install step links a native binary, so don't install with `--ignore-scripts`.
- Claude Code runs in an empty temporary directory with no tools, no MCP servers and no `CLAUDE.md` files. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and the Bedrock, Vertex and Foundry switches are removed from its environment, because Claude Code would prefer them over the token.
- Use counts against the subscription's limits rather than API billing.
- Anthropic intends subscription OAuth for [ordinary use of Claude Code](https://code.claude.com/docs/en/legal-and-compliance) by the subscriber, and points products and services at API keys. Use this provider in your own repositories with your own subscription, and `ANTHROPIC_API_KEY` otherwise.

### Environment

| Variable                      | Description |
| ----------------------------- | ----------- |
| One credential from the table above | Required for the rewrite. Without one, the standard notes are published. |
| `GITHUB_TOKEN` or `GH_TOKEN`  | Used to look up the pull requests behind the release's commits. Needs read access to pull requests. semantic-release on GitHub already has it. Without it, only commits are sent. |
| `GITHUB_API_URL`              | For GitHub Enterprise Server. Set automatically in GitHub Actions. |

## What it sends, and what it asks for

The model gets the `product` text, the standard notes, every commit message in the release, and the title and description of each merged pull request (HTML comments stripped, long descriptions shortened to fit). **For a private repository this content leaves GitHub for OpenAI or Anthropic**, so check that fits your data policy.

It is asked for one or two sentences on what the release means for readers, then bullets under **Breaking changes**, **New**, **Improved** and **Fixed**. It is told to keep every breaking change, merge fixes to features that are new in the same release into those features, leave out changes readers can't notice (refactoring, CI, tests, build), and state only what the input supports. The full prompt is in [`lib/prompt.js`](lib/prompt.js).

semantic-release generates notes a second time when a prepare step creates a commit, as `@semantic-release/git` does. The plugin answers that second call from the first, so each release costs one model call and the published text matches the logged one.

## Previewing on a past release

Nothing is tagged or published:

```bash
GITHUB_TOKEN=$(gh auth token) OPENAI_API_KEY=<key> node scripts/preview.js ../my-repo v1.4.0 v1.5.0
```

Any provider credential works in place of `OPENAI_API_KEY`. Options are read from the repository's JSON `.releaserc` and can be overridden with `--provider`, `--model`, `--product` and `--instructions`. `--prompt` prints what would be sent to the model instead of calling it, which needs no credential.

## Releasing this package

Merges to `main` are released by [`release.yml`](.github/workflows/release.yml), using this checkout of the plugin for its own release notes. npm publishing uses trusted publishing (OIDC), which can only be configured for a package that already exists, so the first release is bootstrapped once:

1. Add a short-lived granular npm token with publish rights on the `@innoactive` scope as the `NPM_TOKEN` secret, and one provider credential (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`).
2. Merge to `main`. The first release publishes `1.0.0`.
3. On npmjs.com, add `Innoactive/semantic-release-ai-notes` / `release.yml` as the package's trusted publisher, then delete the `NPM_TOKEN` secret and the token.

## License

MIT
