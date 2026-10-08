// Stands in for the Claude Code CLI. FAKE_CLAUDE picks the outcome; "echo" reports what it received.
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
    const mode = process.env.FAKE_CLAUDE;
    if (mode === "crash") {
        process.stderr.write("boom");
        process.exit(3);
    }
    const result =
        mode === "expired"
            // Captured from Claude Code 2.1.252 with an expired login: exit 0, subtype "success".
            ? { type: "result", subtype: "success", is_error: true, result: "Failed to authenticate: OAuth session expired and could not be refreshed" }
            : {
                  type: "result",
                  subtype: "success",
                  is_error: false,
                  result: JSON.stringify({
                      args: process.argv.slice(2),
                      input,
                      cwd: process.cwd(),
                      token: process.env.CLAUDE_CODE_OAUTH_TOKEN,
                      apiKey: process.env.ANTHROPIC_API_KEY ?? null,
                      noClaudeMds: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS,
                  }),
              };
    process.stdout.write(JSON.stringify(result));
});
