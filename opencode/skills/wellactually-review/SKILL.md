---
name: wellactually-review
metadata:
  opencode/slash: "true"
description: Review a change, a branch or a pull request against every principle on your Well Actually advisory board
---

Review a change against the principles on the user's advisory board.
Every principle that can apply to the project gets a verdict, so the report says what was checked and found nothing, not only what was found.

You only run this review.
The advice and the diff never enter this conversation: each step runs in a subagent with an almost empty context, reads its inputs from the review directory, writes its result there and answers with one line.
Do not read the diff, the advice or the step files yourself.

## Which agent you are

Read the file for the agent you run in, next to this file, and follow it with the steps below:

- Claude Code: `claude-code.md`
- Codex: `codex.md`
- OpenCode: `opencode.md`
- pi: `pi.md`

It says how you start a subagent, which model each step gets, and what to do when you cannot start subagents.

## 1. Prepare

The change is what the user names: their local changes, a branch, a commit range or a pull request.
When they name nothing, review the local changes, or the branch against the default branch when there are none.

From the repository, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/wellactually.mjs" review [target]
```

`target` is empty for the default, `main...HEAD` for what a branch changed since it left `main`, `a..b` for two commits, or a single ref.
For a pull request, review its head against its base.
When the pull request is what is checked out, as on a CI runner, that is `origin/<base>...HEAD`.
Otherwise fetch it without switching branches, `git fetch origin <base>` and then `git fetch origin pull/<number>/head`, and review `origin/<base>...<sha>` with the sha `git rev-parse FETCH_HEAD` printed.

The command prints a few lines and the review directory, which every later step needs.
It leaves out only generated code: lockfiles, files marked `linguist-generated`, and files whose first lines say they are generated.
It downloads the advisory board first when this machine has never synced it, as on a fresh CI runner with `WELLACTUALLY_TOKEN` set.

- When the change is empty or the advisory board has no principles, say so and stop.
- When it says there is no advisory board on this machine, the user signs in with the login skill first, or sets `WELLACTUALLY_TOKEN` on a CI runner.

## 2. Filter

Start one subagent with the cheap model: "Read `<dir>/steps/router.md` and do it for the review in `<dir>`."
It writes `scope.json`, the principles that can apply to this project, and `map.md`, a map of the change.
Then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/wellactually.mjs" review --route <dir>
```

It decides from the size of the advice and the diff, never from how much room a model thinks it has.
Pass `--budget` only when the user names one, such as `--budget 1m` for a model with a window of a million tokens.
It prints `Route: single` or `Route: sets`.

## 3. Cut into change sets, for `Route: sets` only

Start one subagent with the cheap model: "Read `<dir>/steps/splitter.md` and do it for the review in `<dir>`."
Then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/wellactually.mjs" review --sets <dir>
```

When it says the change sets need fixing, send its message to the same subagent and run the command again.

## 4. Review

`<dir>/jobs.json` lists the reviewers, each with an `id`.
When it is empty because every principle is out of scope, skip review, testing and verification workers and write the report with those exclusions.
Start one subagent per job with the review model, all at once: "Read `<dir>/steps/reviewer.md` and do job `<id>` of the review in `<dir>`."
After the change sets, start one more: "Read `<dir>/steps/reviewer.md` and do the crossing pass of the review in `<dir>`."

Each answers with how many verdicts it wrote.
Run `node "${CLAUDE_PLUGIN_ROOT}/dist/wellactually.mjs" review --check <dir> --stage review`.
Send missing or invalid outputs back to their workers; after one repair attempt, report any remaining gap as incomplete.

## 5. Test and seek counterexamples

Start one testing subagent per review unit with the review model: "Read `<dir>/steps/testing.md` and test unit `<unit>` of the review in `<dir>`."
Without change sets the unit is `all`; otherwise it is each set id, plus `crossing` for contracts between sets.
The tester may skip execution when the unit has no executable behavior, and records why.
Wait for its results before verification.
Run `node "${CLAUDE_PLUGIN_ROOT}/dist/wellactually.mjs" review --check <dir> --stage test`.
Resolve missing results before going on, or report the review as incomplete.

## 6. Verify

Start the verifiers with the review model, all at once.
Without change sets that is one: "Read `<dir>/steps/verifier.md` and verify the findings of the review in `<dir>`."
With change sets it is one per set, and one for the crossing pass: "Read `<dir>/steps/verifier.md` and verify the findings of `<set>` in `<dir>`", with the set's id such as `set-01`, or `crossing`.

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/wellactually.mjs" review --check <dir> --stage verify`.
Send gaps back to the responsible verifier before reporting a complete review.

## 7. Report

Start one subagent with the review model: "Read `<dir>/steps/report.md` and write the report of the review in `<dir>`."
It also tells each principle's expert how it went, and answers with the report.
Run `node "${CLAUDE_PLUGIN_ROOT}/dist/wellactually.mjs" review --check <dir> --stage report` before presenting it as complete.
Give the returned report to the user; when the check fails or a worker hits a limit, clearly name the unfinished stages.
A successful agent exit or a `done` message does not substitute for these checks.
Do not require a `report.md` file: some hosts only allow report workers to return text.

Reviewers and testers may read repository files, trace callers, execute local checks, and write probes or alter tests in disposable copies, as `testing.md` describes.
Give every worker the file, shell and findings MCP tools needed for its job within the host's permissions.
Do not restrict shell access to `git` and the preparation command: that prevents tests and counterexamples.
Do not grant unrestricted permissions or bypass the host's approval rules.
Keep the reviewed working tree unchanged; findings and reproduction artifacts belong in the review directory or a disposable checkout.
Do not fix product code or post to the pull request unless the user asks for that.

## When something fails

When a command above still shows `${CLAUDE_PLUGIN_ROOT}` instead of the plugin's path, use the nearest directory above this file that holds `dist/wellactually.mjs` in its place.

When the shell finds no `node`, tell the user the plugin needs Node 20 or newer, which they install from <https://nodejs.org>, and to restart their agent after that.
