# hooks

When the plugin runs.

`hooks.json` calls the `wellactually` command in [dist](../dist) on the events that matter: a session starting and ending, a prompt, a tool call before and after it runs, and a compaction.
That is how a principle's detector sees what the agent does, and how its advice reaches the agent.

Claude Code and Codex both read this file.
