<p align="center">
  <img src="assets/illustration.png" width="420" alt="An experienced developer raises one finger over the shoulder of a coding robot">
</p>

<h1 align="center">Well Actually</h1>

<p align="center">
  <em>Well actually, that's not idiomatic React.</em>
</p>

Your coding agent is a capable generalist.
It has not spent years in your framework, your niche or closed source enterprise software.
Well Actually brings what the experts there have learned into your agent.

Principles are not hard rules like a linter's.
They are advice, like an expert glancing over a diff who has seen a pattern go wrong twenty times: it is most likely wrong again, and there is a better way.
Your agent hears it and decides.

A principle is advice plus a detector.
The detector looks at what your agent just did, and when it finds something, the agent reads the advice.
Unlike a rules file, nothing sits in your agent's context up front: advice only enters it when it applies.
Anyone can publish principles on [the Well Actually registry](https://wellactually.dev), and you choose whose principles sit on your advisory board.

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

```bash
codex plugin add wellactually@wellactually
```

Then open Codex, approve the plugin's hooks with `/hooks`, and type `$wellactually:login`.
Codex does not run a new plugin's hooks until you approve them, so no principle reaches the agent before that.

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
- It has 100 ms and 32 MB.
  One that exceeds either is stopped and reported, and your agent carries on.
- Whatever a detector reports must occur word for word in its input, or the finding is dropped.
  A detector cannot compose text for your agent at runtime.
- Each download is checked against its content hash before it is stored.
- Updates are automatic.
  What an expert on your advisory board releases runs from your next sync, so follow the experts you trust.
  You can switch off any single principle, or unfollow the expert.

The code that does this is in `packages/core`: `sandbox.ts` is the isolate, `board.ts` runs an advisory board.

## What leaves your machine

- How often each principle fired: a day, a hash and a count.
- A rating, when your agent gives one: the principle's hash and `up`, `down` or `not_applicable`.

No path, file content, prompt, command or finding is sent.
`wellactually stats off` turns both off.

## Write a principle

A principle is a directory, and its name is the principle's id:

```text
avoid-late/
  principle.md      the advice: a heading, one sentence of summary, then the rest
  detector.ts       a handler per event it reacts to: onWrite, onRead, onPrompt, onCommand, onOutput
  detector.test.ts  the tests: what the detector reports for an event
```

A detector reads `onWrite({ globs: ["**/*.dart"], *detect(event) { ... yield { line: written.line }; } })`.
A test reads `expect(detect(write("lib/user.dart", code))).toEqual([{ line: 2 }])`.
The tests must pass, make the detector fire at least once, and show it staying quiet at least once.
`principles/passsy` holds the examples: Pascal's own principles.

```bash
wellactually init avoid-late
```

```bash
wellactually test avoid-late
```

```bash
wellactually publish avoid-late
```

`publish` uploads a private draft, and you release it on the website.
Building a principle needs esbuild, which the plugin does not carry, so the authoring commands need the command installed from a checkout of this repository:

```bash
npm install && npm link -w wellactually
```

A detector may import `@wellactually/sdk/v3`, which is in `packages/sdk`, its own files, and packages from npm that its `package.json` names.
The `v3` is the detector API version it is written against.

## What is in here

| Path                | What it is                                                                    |
| ------------------- | ----------------------------------------------------------------------------- |
| `hooks`, `commands` | The plugin: when the hook runs, and the `login` and `sync` commands.          |
| `dist`              | The command as one file, built from `packages/cli`. The plugin runs it.       |
| `packages/core`     | Builds, checks and runs principles: the isolate and the local advisory board. |
| `packages/sdk`      | The types and helpers a detector may import.                                  |
| `packages/cli`      | The `wellactually` command and its MCP server.                                |
| `principles`        | Example principles.                                                           |

The registry is not in this repository.

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
