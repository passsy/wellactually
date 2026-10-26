# Running the review in Codex

When your tools include one that starts a subagent, such as `spawn_agent`, start each step with it and the prompt the step gives, with your own model for every step.
Start the subagents of one step at the same time, and wait for all of them before the next step.

When you have no such tool, follow `pi.md` instead.

The commands show `${CLAUDE_PLUGIN_ROOT}`, which Codex does not set: use the nearest directory above this file that holds `dist/wellactually.mjs` in its place.
