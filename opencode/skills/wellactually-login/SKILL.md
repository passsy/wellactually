---
name: wellactually-login
description: Connect this machine to your Well Actually advisory board
---

Sign the user in to Well Actually and download their advisory board.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/dist/wellactually.mjs" login` in the background. It prints a link and a code, then waits until the user has confirmed the code in their browser.
2. Show the user the link and the code right away, and ask them to open it.
3. When the command has finished, it has also downloaded the advisory board. Tell the user how many principles are on it, as the command printed. Only when it says it could not download the board, run `node "${CLAUDE_PLUGIN_ROOT}/dist/wellactually.mjs" sync`.

If the advisory board is empty, the command lists experts they can follow. Show the user those experts with their links, and tell them to follow the ones they like on the website and then sync again: `/wellactually:sync` in Claude Code, `$wellactually:sync` in Codex, `/wellactually-sync` in OpenCode, `/skill:wellactually-sync` in pi. Name only the one for the agent you are.

When a command above still shows `${CLAUDE_PLUGIN_ROOT}` instead of the plugin's path, as in Codex, use the nearest directory above this file that holds `dist/wellactually.mjs` in its place.
