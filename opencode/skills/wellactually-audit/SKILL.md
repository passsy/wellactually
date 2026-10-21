---
name: wellactually-audit
metadata:
  opencode/slash: "true"
description: Check what Well Actually did in your recent agent sessions, whether the hooks ran, which principles fired, and whether the agent rated their advice
---

Find out from the files on this machine what Well Actually did in the user's recent sessions, and explain it.
For a session, answer four questions in this order, since each one needs the one before:

1. Is the plugin installed and on in the agent the session ran in?
2. Did its hooks run in that session?
3. Did a detector fire, and did its advice reach the agent?
4. Did the agent rate that advice with `rate_principle`?

Where one of them did not happen, say why, with the line of the file that shows it.
When the user asks why the agent does not rate, and advice did reach it, setup is not the cause: go to the fourth question.

Start with the session the user asks about.
When they name none, take the newest few sessions of the agent they asked about, or of every agent below that is on this machine.
Leave out the session you run in, and earlier audits: they match every marker below because they read this file.
Search the files with `grep`, `jq` or `sqlite3` for the markers below instead of reading them whole: a conversation file runs to megabytes.
Read only, change nothing, and send nothing anywhere.
The conversations hold everything the agents saw, so quote no more of them than the answer needs.
When the formats below no longer match what you find, because an agent changed how it stores its sessions, look at the file and adapt, and say so.

## Well Actually's own files

They are in `~/.wellactually`, or in `$WELLACTUALLY_HOME` when that is set.

- `logs/hooks-<YYYY-MM-DDTHH>.jsonl`: the hook log, one file per hour in UTC, kept for one day.
  One line per hook call: `time`, `hook` (such as `UserPromptSubmit` or `PostToolUse`), `session`, `transcript` (the agent's conversation file), `cwd`, `shown` (characters of advice the agent was given, 0 for none), and `note` (why no detector ran, when none did).
  `events[].detectors[]` holds every detector that ran, with its `id`, its `findings` (it fired when they are not empty), and `error` or `thrown` when it failed.
  `events[].skipped[]` holds the principles that did not run and why, such as switched off.
  `grep -h '"session":"<id>' ~/.wellactually/logs/*.jsonl` gives one session's calls, and `jq -s 'group_by(.hook) | map({hook: .[0].hook, calls: length, advised: map(select(.shown > 0)) | length})'` counts them.
  `session` is the agent's own session id, and `transcript` the path of its conversation, which tells the agents apart: `/.claude/`, `/.codex/`, `/.pi/`, or a session id starting with `ses_` for OpenCode.
  Most calls give no advice, so a session with many calls of `shown` 0 and a few above it is normal.
  `WELLACTUALLY_HOOK_LOG=0` where the agent runs turns the log off.
- `hook.log`: the hook's crashes, each with a timestamp and a stack trace.
- `config.json`: `token` is there when the user signed in, and `stats: false` means reporting is off, so ratings are not sent.
- `board.json`: the advisory board, with `syncedAt` and `entries`, each with a principle's `id` and whether it is `enabled`.
- `disabled.json`: `projects` lists the folders where all advice is switched off, `disabled` the principles switched off everywhere.
  A project switches principles off in `.wellactually.json` at its root.

## Advice and ratings in a conversation

Advice starts with `<wellactually>` on a line of its own and ends with `</wellactually>`.
In a JSON line the newline is escaped, so search for `<wellactually>\n` there.
Each principle in it is `<principle id="owner/name" ...>`, and every complete block ends by asking the agent to rate with `rate_principle`.
A block without its closing tag was cut short by the agent, and the model did not read the rest.

A rating is a call of the MCP tool whose name ends in `rate_principle`, with an `id` and a `rating` of `up`, `down` or `not_applicable`.
The server answers `Recorded <rating> for <id>@<version>` when it took the rating, and says why when it did not.
The word `rate_principle` is in every block of advice and in the agent's list of tools, so a file that contains it has not necessarily rated: search for the call markers below, or for the server's `Recorded` answer.

## Claude Code

- Setup: in `~/.claude/settings.json` (or under `$CLAUDE_CONFIG_DIR`), `enabledPlugins` has a key starting with `wellactually@` set to `true`.
  `plugins/installed_plugins.json` lists the installed version.
  A project's `.claude/settings.json` can enable or disable it too.
- Conversations: `~/.claude/projects/<the folder with each / as ->/<session id>.jsonl`, and subagents' in a folder next to it.
  Those folder names start with `-`, so pass them to `grep` and `ls` as `./-Users-...` or after `--`.
- Hook runs: attachments of `"type":"hook_success"` with a `command` that names `wellactually`.
  Other `hook_` types, or a non-zero `exitCode`, are failed runs, with the error in `stderr`.
- Advice: attachments of `"type":"hook_additional_context"`, with the text in `attachment.content`.
- Ratings: `tool_use` parts with `"name":"mcp__plugin_wellactually_wellactually__rate_principle"`, answered by the `tool_result` with the same `tool_use_id`.

## Codex

- Setup: in `~/.codex/config.toml` (or under `$CODEX_HOME`), a table `[plugins."wellactually@..."]`, which `enabled = false` switches off.
  Codex runs a plugin's hook only once the user trusted it in `/hooks`, and says nothing while it is not.
  A trusted hook has a table `[hooks.state."wellactually@...:hooks/hooks.json:<event>:0:0"]` with a `trusted_hash`.
  The plugin registers `session_start`, `user_prompt_submit`, `pre_tool_use`, `post_tool_use`, `post_compact` and `session_end`, so check each of them.
  Codex asks again after an update changed a hook.
  The installed versions are folders in `~/.codex/plugins/cache/<marketplace>/wellactually/`.
- Conversations: `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<session id>.jsonl`.
  Its `session_meta` line has the `id` and `cwd`.
  A subagent has a file of its own, whose `session_meta` names the session that started it as `session_id`, and its hooks are logged under that one.
  A `turn_context` line whose `disabled_plugin_ids` has `wellactually@...` means the plugin was off in that session.
  The plugin was loaded when the skills Codex lists name a folder `.../wellactually/<version>/skills`.
- Hook runs: Codex does not record them, so the hook log is the only evidence.
- Advice: `response_item` lines with `"role":"developer"` whose text starts with `<wellactually>`.
- Ratings: `event_msg` lines with an `McpToolCall` item with `"tool":"rate_principle"`, with its `arguments` and the server's `result`.
  Codex records that item also when the agent called the tool from a script.
  Older versions record only a `function_call` named after the tool, answered by the `function_call_output` with the same `call_id`.

## OpenCode

- Setup: OpenCode loads the plugin when an `opencode.json` or `opencode.jsonc` names `wellactually` under `plugin` or `plugins`: the global one in `~/.config/opencode/`, or the project's, at its root or in its `.opencode` folder.
  It is installed with `opencode plugin add 'github:passsy/wellactually#path:opencode'`.
  OpenCode starts the hook with `node`, which needs Node 20 or newer on the PATH.
- Conversations: a SQLite database, `~/.local/share/opencode/opencode.db` (or under `$XDG_DATA_HOME`).
  Open it with `sqlite3 -readonly`, and query only the session tables below: the others hold the user's credentials.
  OpenCode 2 keeps sessions in `session_v2` (`id`, `directory`, `time_updated` in milliseconds, which `datetime(time_updated / 1000, 'unixepoch')` makes readable) and their messages in `session_message` (`session_id`, `type`, and `data` as JSON).
  OpenCode 1 keeps them in `session` and `part` (`session_id`, `data`).
  A database can have both, so look in each.
  Session ids start with `ses_`.
- Hook runs: OpenCode does not record them, so the hook log is the only evidence.
- Advice: in `synthetic` and `system` messages, and in what a tool answered, which is in an `assistant` message's `content` parts, so search `data` for `<wellactually>`.
- Ratings: a tool part named `rate_principle`, with its `input` and the answer in its `state`.
  In code mode the agent calls it from a script, as `tools.wellactually.rate_principle({ id: "...", rating: "up" })` in `state.input.code`, and the server's answer `Recorded ...` is in the script's result.
  A script that only searches the tools for it is no rating.

## pi

pi keeps its sessions in `~/.pi`, and the hook log names a session's file under `transcript`.

## Why something did not happen

- The plugin is not installed or is switched off, see the agent's setup above.
- Codex hooks that are not trusted in `/hooks`, the most common reason Codex shows no advice.
- The session started before the plugin was installed or enabled: a running session picks a plugin up only after a restart.
- The project or the principle is switched off in `disabled.json` or the project's `.wellactually.json`.
- No detector fired: the hooks ran on what the agent did, and nothing the principles are about happened.
  A `note` in the hook log says when no detector ran at all.
- A detector failed: its `error` or `thrown` in the hook log, or a crash in `hook.log`.
- The hook gave advice (`shown` above 0) that is not in the conversation: the agent did not pass it to the model.
- A `note` starting with `left out` means advice was dropped to stay within what the agent shows in full.
- Advice that was shown before in the same session is not shown again.
- The hook log keeps one day, so an older session has only its conversation to go by.
- No line in the hook log for a session whose conversation shows advice or hook runs: the log is off with `WELLACTUALLY_HOOK_LOG=0`, or the hooks wrote to another `WELLACTUALLY_HOME`.

Ratings are up to the agent.
It is asked to rate once it knows how the advice went, and agents often leave it out even when the advice helped.
Advice without a rating is normal, unless one of these explains it:

- All of it came from principles whose id starts with `local/`, which ask for no rating.
- The advice was cut short before it asked to rate.
- `rate_principle` was not among the agent's tools, because the plugin's MCP server did not start.
  Where the agent loads tools on demand, as Codex does, it had to search for the tool first, and the advice tells it so.
- The server did not record the rating, and its answer says why.
- `stats` is `false` in `config.json`, so the rating was not sent.

## The answer

Answer the user's question first, in plain words.
Then the evidence: the session, the folder it ran in, and the lines that show it.
Say what you could not tell, and why.
When a fix is the user's to make, such as trusting the hooks in Codex's `/hooks`, adding the plugin to `opencode.json` or restarting the agent, name that step.
