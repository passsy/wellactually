# Running the review in Codex

When your tools include one that starts a subagent, such as `spawn_agent`, start each step with it and the prompt the step gives, with your own model for every step.
Start each with an empty conversation rather than inheriting the user's review session; when `spawn_agent` exposes `fork_turns`, use `"none"`.
Start principle reviewers and exploratory testers at the same time. Wait for both before verification.

When you have no such tool, follow `pi.md` instead.

The commands use `<skill>` for the directory containing this skill's `SKILL.md`; its helper is `scripts/review.mjs`.

Workers need repository reading, file writing, shell execution for tests and probes, and the available findings MCP tools.
Use general-purpose workers rather than a restricted read-only reviewer role.
They may inspect callers outside the changed files and write reproduction artifacts in their own directories.
Preserve host sandbox and approval controls; missing tools must be reported as limitations.
The coordinator records verified findings through the MCP, following `findings.md`; do not replace it with handwritten MCP storage.
