# Well Actually

Engineering principles that run inside your coding agent.

A principle is advice plus a detector.
The detector looks at what your agent just did, and when it finds something, the agent reads the advice.
Anyone can publish principles on [wellactually.dev](https://wellactually.dev), and you choose whose principles sit on your advisory board.

> wellactually.dev is not live yet.
> Until it is, this repository is here to be read, not installed.

## Install

Claude Code:

```text
/plugin marketplace add passsy/wellactually
/plugin install wellactually@wellactually
/wellactually:login
```

The last line connects this machine to your advisory board and downloads it.

Codex:

```bash
codex plugin marketplace add passsy/wellactually
```

The plugin needs Node 20 or newer and nothing else.

## What it does on your machine

- When your agent writes or reads a file, gets a prompt or is about to run a shell command, a hook shows that one input to the detectors on your advisory board.
- A detector that finds something puts its expert's advice in front of the agent, once per session in full and as a pointer after that.
- The hook never uses the network.
  It reads the principles `sync` downloaded earlier.
- `sync` runs when a session starts.
  It downloads what is new on your advisory board and reports counts, see "What leaves your machine".

## Detectors are other people's code

So they are contained.

- A detector runs in a QuickJS WebAssembly isolate.
  It gets its input as JSON and returns findings as JSON.
  There is no network and no process inside.
- It can read text files on your machine and cannot change any.
  Without a network there is nowhere to send them, and the next point keeps them out of your agent's context.
- It has 50 ms and 32 MB.
  One that exceeds either is stopped and reported, and your agent carries on.
- Whatever a detector reports must occur word for word in its input, or the finding is dropped.
  A detector cannot compose text for your agent at runtime.
- Each download is checked against its content hash before it is stored.
- Updates are automatic.
  What an expert on your advisory board releases runs from your next sync, so add the experts you trust.
  You can switch off any single principle, or remove the expert.

The code that does this is in `packages/core`: `sandbox.ts` is the isolate, `board.ts` runs an advisory board.

## What leaves your machine

- How often each principle fired: a day, a hash and a count.
- A rating, when your agent gives one: the principle's hash and `up`, `down` or `not_applicable`.

No path, file content, prompt, command or evidence is sent.
`wellactually stats off` turns both off.

## Write a principle

A principle is a directory, and its name is the principle's id:

```text
avoid-late/
  principle.md      the advice: a heading, one sentence of summary, then the rest
  detector.ts       export function* detect(ctx), plus the events and globs it runs on
  detector.test.ts  the tests: what the detector reports for an event
```

A test reads `expect(detect(write("lib/user.dart", code))).toEqual([{ line: 2, evidence: "late String name;" }])`.
The tests must pass, make the detector fire at least once, and show it staying quiet at least once.
`principles/` holds three examples.

```bash
wellactually init avoid-late
```

```bash
wellactually test avoid-late
```

```bash
wellactually publish avoid-late -m "First version"
```

`publish` uploads a private draft, and you release it on the website.
Building a principle needs esbuild, which the plugin does not carry, so the authoring commands need the command installed from a checkout of this repository:

```bash
npm install && npm link -w wellactually
```

A detector may import `@wellactually/sdk`, which is in `packages/sdk`, and its own files.

## What is in here

| Path                | What it is                                                                    |
| ------------------- | ----------------------------------------------------------------------------- |
| `hooks`, `commands` | The plugin: when the hook runs, and the `login` and `sync` commands.          |
| `dist`              | The command as one file, built from `packages/cli`. The plugin runs it.       |
| `packages/core`     | Builds, checks and runs principles: the isolate and the local advisory board. |
| `packages/sdk`      | The types and helpers a detector may import.                                  |
| `packages/cli`      | The `wellactually` command and its MCP server.                                |
| `principles`        | Example principles.                                                           |

The registry behind wellactually.dev is not in this repository.

## Build it yourself

```bash
npm install
```

```bash
npm test
```

```bash
npm run build
```

`npm run build` writes `dist/wellactually.mjs`, the file the plugin runs.

## License

MIT
