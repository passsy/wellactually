# Running the review in Codex

When your tools include one that starts a subagent, such as `spawn_agent`, start each step with it and the prompt the step gives, with your own model for every step.
Start each with an empty conversation rather than inheriting the user's review session; when `spawn_agent` exposes `fork_turns`, use `"none"`.
Start the subagents of one step at the same time, and wait for all of them before the next step.

When you have no such tool, follow `pi.md` instead.

The commands show `${CLAUDE_PLUGIN_ROOT}`, which Codex does not set: use the nearest directory above this file that holds `dist/wellactually.mjs` in its place.

Workers need repository reading, file writing, shell execution for tests and probes, and the available findings MCP tools.
Use general-purpose workers rather than a restricted read-only reviewer role.
They may inspect callers outside the changed files and write reproduction artifacts in their own directories.
Preserve host sandbox and approval controls; missing tools must be reported as limitations.
The report worker records verified findings through the MCP, following `findings.md`; do not replace it with handwritten MCP storage.
