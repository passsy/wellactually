---
description: Connect this machine to your Well Actually advisory board
---

Sign the user in to Well Actually and download their advisory board.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/dist/wellactually.mjs" login` in the background. It prints a link and a code, then waits until the user has confirmed the code in their browser.
2. Show the user the link and the code right away, and ask them to open it.
3. When the command has finished, run `node "${CLAUDE_PLUGIN_ROOT}/dist/wellactually.mjs" sync` and tell the user how many principles are on their advisory board.

If the advisory board is empty, tell them to add experts on the website and run `/wellactually:sync`.
