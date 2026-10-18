# dist

The built command, which Claude Code, Codex and pi run from here.

| Agent       | What it runs                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Claude Code | `wellactually.mjs`, from the hooks in [hooks](../hooks) and as its MCP server                    |
| Codex       | `wellactually.mjs`, the same way                                                                 |
| pi          | `pi.mjs`, its extension, which starts `wellactually.mjs` beside it                               |
| OpenCode    | Not this folder: [opencode](../opencode) has its own copy, because only that folder is installed |

- `wellactually.mjs` is the `wellactually` command: the hooks, the MCP server and the authoring commands.
- `wellactually-worker.mjs` runs detectors in worker threads, and `wellactually-log.mjs` writes the hook log after the hook has answered.

An agent copies a plugin from git without running `npm install` or a build, so these files are committed.
They are built from [packages](../packages) with `npm run build`, with every dependency bundled.
