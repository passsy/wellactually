---
name: sync
description: Download the advisory board you set up on the Well Actually website
---

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/wellactually.mjs" sync` and report what it printed: how many principles are on the advisory board, how many are enabled, and what was downloaded or removed.

If the advisory board is empty, it lists experts the user can follow. Show the user those experts with their links, and tell them to follow the ones they like on the website and then sync again: `/wellactually:sync` in Claude Code, `$wellactually:sync` in Codex, `/wellactually-sync` in OpenCode, `/skill:wellactually-sync` in pi. Name only the one for the agent you are.

It also runs by itself whenever a session starts, so this is only needed after changing the advisory board in the middle of a session.

When a command above still shows `${CLAUDE_PLUGIN_ROOT}` instead of the plugin's path, as in Codex, use the nearest directory above this file that holds `dist/wellactually.mjs` in its place.
