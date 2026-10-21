---
name: audit
description: Check what Well Actually did in your recent agent sessions, whether the hooks ran, which principles fired, and whether the agent rated their advice
---

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/wellactually.mjs" audit` and explain to the user what it printed.

It looks back one day, as far as the hook log reaches, at the sessions of Claude Code, Codex and OpenCode on this machine.
For each session it says whether the hooks ran, which detectors fired, what advice reached the agent, and whether the agent rated that advice with `rate_principle`.
Where something did not happen, it names the likeliest reason.

Narrow it to what the user asked about:

- `--agent codex`, `--agent claude-code` or `--agent opencode` for one agent's sessions.
- `--session <id>` for one session, by the start of its id.
- `--hours 72` to look further back.
  The hook log keeps one day, so older sessions show only what their conversation recorded.
- `--json` for every session with all details.

When the text leaves out a session the question is about, run the command again with `--session` or `--json` yourself instead of asking the user to.

Answer the user's question first, in plain words, then the evidence: the session, the folder it ran in and the line that shows it.
Report what the command found, and say when it could not tell.
When a line names a fix, such as trusting the hooks in Codex's `/hooks` or adding the plugin to opencode.json, tell the user that step.

Ratings are up to the agent.
It is asked to rate once it knows how the advice went, and agents often leave it out even when the advice helped.
A session with advice and no rating is normal unless the command names a cause, such as a missing `rate_principle` tool or reporting switched off.

The command only reads files on this machine: the hook log in `~/.wellactually/logs` and the agents' own conversations.
It sends nothing.
Those conversations hold everything the agents saw, so quote no more of them than the answer needs.

When a command above still shows `${CLAUDE_PLUGIN_ROOT}` instead of the plugin's path, as in Codex, use the nearest directory above this file that holds `dist/wellactually.mjs` in its place.

When the shell finds no `node`, tell the user the plugin needs Node 20 or newer, which they install from <https://nodejs.org>, and to restart their agent after that.
