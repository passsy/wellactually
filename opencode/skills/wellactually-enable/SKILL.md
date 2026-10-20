---
name: wellactually-enable
metadata:
  opencode/slash: "true"
description: Show Well Actually advice in this project again, or switch one principle back on
---

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/wellactually.mjs" enable` from the folder you work in, and report what it printed.
The advisory board then shows its advice in this project again.

When the user named a principle, such as `passsy/avoid-late`, switch on only that one: `node "${CLAUDE_PLUGIN_ROOT}/dist/wellactually.mjs" enable passsy/avoid-late`.
Add `--global` when it was switched off everywhere.

The command records the switch in `~/.wellactually`, outside the project.
Where a sandbox lets you write only inside the project, as in Codex, run it with permission to write there from the start, so the user is asked once.

When a command above still shows `${CLAUDE_PLUGIN_ROOT}` instead of the plugin's path, as in Codex, use the nearest directory above this file that holds `dist/wellactually.mjs` in its place.

When the shell finds no `node`, tell the user the plugin needs Node 20 or newer, which they install from <https://nodejs.org>, and to restart their agent after that.
