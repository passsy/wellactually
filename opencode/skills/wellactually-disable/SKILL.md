---
name: wellactually-disable
metadata:
  opencode/slash: "true"
description: Stop Well Actually advice in this project, or switch off one principle
---

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/wellactually.mjs" disable` from the folder you work in, and report what it printed.
From then on no principle on the advisory board shows advice in this project, on this machine.
Other projects keep their advice.

When the user named a principle, such as `passsy/avoid-late`, switch off only that one: `node "${CLAUDE_PLUGIN_ROOT}/dist/wellactually.mjs" disable passsy/avoid-late`.
Add `--global` only when they asked for it to be off everywhere.

To switch it on again, the user runs the enable skill: `/wellactually:enable` in Claude Code, `$wellactually:enable` in Codex, `@wellactually-enable` in OpenCode 2, `/wellactually-enable` in OpenCode 1, `/skill:wellactually-enable` in pi.
Name only the one for the agent you are.

The command records the switch in `~/.wellactually`, outside the project.
Where a sandbox lets you write only inside the project, as in Codex, run it with permission to write there from the start, so the user is asked once.

When a command above still shows `${CLAUDE_PLUGIN_ROOT}` instead of the plugin's path, as in Codex, use the nearest directory above this file that holds `dist/wellactually.mjs` in its place.

When the shell finds no `node`, tell the user the plugin needs Node 20 or newer, which they install from <https://nodejs.org>, and to restart their agent after that.
