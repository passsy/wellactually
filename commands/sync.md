---
description: Download the advisory board you set up on the Well Actually website
---

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/wellactually.mjs" sync` and report what it printed: how many principles are on the advisory board, how many are enabled, and what was downloaded or removed.

It also runs by itself whenever a session starts, so this is only needed after changing the advisory board in the middle of a session.

When a command above still shows a `$` variable instead of the plugin's path, as in Codex, use the nearest directory above this file that holds `dist/wellactually.mjs` in its place.
