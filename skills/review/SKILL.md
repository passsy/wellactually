---
name: review
description: Review a change, a branch or a pull request against every principle on your Well Actually advisory board
---

Review a change against the principles on the user's advisory board.
Every principle gets a verdict, so the report can say what was checked and found nothing, not only what was found.

The change is what the user names: their local changes, a branch, a commit range or a pull request.
When they name nothing, review the local changes, or the branch against the default branch when there are none.

## 1. Prepare

From the repository, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/wellactually.mjs" review [target]
```

`target` is empty for the default, `main...HEAD` for what a branch changed since it left `main`, `a..b` for two commits, or a single ref.
For a pull request, review its head against its base.
When the pull request is what is checked out, as on a CI runner, that is `origin/<base>...HEAD`.
Otherwise fetch it without switching branches, `git fetch origin <base>` and then `git fetch origin pull/<number>/head`, and review `origin/<base>...<sha>` with the sha `git rev-parse FETCH_HEAD` printed.
Detectors that read other files of the project read them from disk, so a review of what is checked out is the most accurate.

The command writes the review to a directory it prints:

- `diff.patch`: the change.
  Lockfiles, files marked `linguist-generated` and files with a diff over 64 KB are left out, and the command's output names each with its reason.
- `project.md`: the project's top level, its manifests and the start of its README.
- `principles.md`: one line per principle with its id, detector hits, tags, title and summary.
- `principles/`: each principle's full advice, with the lines its detector fired on in this change.
- `plan.json`: all of it as JSON.

When the change is empty or the advisory board has no principles, say so and stop.
When the command says there is no advisory board on this machine, the user signs in with the login skill first.
When it says no detector saw a file, such as a binary or a very large one, check that file by reading it, and say so in the report.

## 2. Plan

Read `principles.md` and `project.md`, not the diff.
Put every principle either into a review group, or out of scope with a one-line reason.

- Out of scope means the principle cannot apply to this project: Flutter advice in a Rust command-line tool, client-side advice in a backend-only service.
  Never put a principle out of scope because the change looks unrelated to it.
  Checking it costs one line of output.
- When you are not sure, it goes into a group.
- Group by topic, so one reviewer holds related advice: architecture, API and boundaries, tests, security, language and framework, the change itself.
  Keep a group to about a dozen principles and about 40 KB of advice files, and use as few groups as that allows.
- Every principle is in exactly one place.

Write the plan to `groups.json` in the review directory: `{ "groups": [{ "name": "...", "principles": ["id", ...] }], "outOfScope": [{ "id": "...", "reason": "..." }] }`.

## 3. Check every principle

Start one reviewer per group, all at once, with the prompt below.
Where you can start subagents, as in Claude Code, OpenCode or a Codex that has them, each reviewer is a subagent.
Where you cannot, as in pi, do the groups yourself one after another, and reread the rules below before each.

> You review a change against a set of principles, each the advice of an expert.
> First read `<dir>/diff.patch` in full.
> Then read the advice of each of these principles: `<dir>/principles/<file>` for <ids>.
> Read the code around the change in the repository where you need it.
> Do not change any file.
>
> Give every principle exactly one verdict:
> - `not_applicable`: the change does nothing the principle is about.
> - `followed`: the change does something the principle is about, and does it right.
> - `findings`: the change breaks the principle, with one finding per place.
>
> A principle with detector hits lists where its detector fired.
> A hit is a candidate, not a finding: confirm it as a finding, or dismiss it with the reason it does not apply.
>
> Only report what this change introduced: lines it added or removed, or something it should have changed and did not.
> What was wrong before the change is not a finding.
> A finding must be something the principle's advice actually says.
> Quote the sentence of the advice it rests on.
> Leave out what a compiler, a linter or a formatter would catch.
>
> Answer with JSON only: `[{ "principle": "id", "verdict": "not_applicable" | "followed" | "findings", "findings": [{ "file": "path", "line": 12, "priority": "p0".."p4", "evidence": "proven" | "reasoned" | "speculative", "problem": "...", "fix": "...", "quote": "...", "fromDetector": true }], "dismissed": [{ "file": "path", "line": 12, "reason": "..." }] }]`.
> Priority: p0 breaks production or data, p1 a real bug or a broken contract, p2 a problem a reviewer would block on, p3 worth fixing, p4 a nit.
> Evidence: proven when you can show it, such as with a failing input; reasoned when it follows from the code; speculative when it depends on something you could not see.

A reviewer that skipped a principle of its group is asked again for that one.

## 4. Verify

Every finding is checked once more by an agent that did not raise it, with the diff, the code and the principle's advice: is it in the change, does the code really do this, and does the advice really say it.
Give each verifier the findings of one group.
Drop what it cannot confirm, and move a dismissed detector hit to `dismissed` with the verifier's reason.
Two findings about the same place keep the one with the higher priority, naming both principles.

## 5. Rate

Tell each principle's expert how it went, once per principle, with the MCP tool whose name ends in `rate_principle` (search your tools for that word if it is not loaded):

- `up` when a finding of it stood after verification.
- `not_applicable` when its detector fired in this change and every hit was dismissed because it matched something the advice is not about.
  A hit on something the advice is about, where the change already follows it, is no reason to rate.
- Nothing for a verdict of `not_applicable` or `followed`, and nothing for a finding of a principle without a detector that did not stand.
  That was the reviewer's mistake, not the advice's.

Principles whose id starts with `local/` are not rated.
When the tool says the machine is not signed in, as on a CI runner without a token, say once that ratings were not sent and carry on.

## 6. Report

Write `findings.json` to the review directory: the verdict of every principle, the verified findings, the dismissed hits and the plan.

Then answer the user, findings first, ordered by priority and then by evidence.
Each finding names its place as `file:line`, the principle's id, the problem and the fix, in a sentence or two each.
After the findings, say what was covered in one line, such as "96 principles: 4 with findings, 11 followed, 63 not applicable, 18 out of scope", then the out-of-scope principles with their reasons, and what the command left out and why.
Name the review directory, so the user can open `findings.json`.

Do not fix anything, and do not post to the pull request, unless the user asks for that.

When a command above still shows `${CLAUDE_PLUGIN_ROOT}` instead of the plugin's path, as in Codex, use the nearest directory above this file that holds `dist/wellactually.mjs` in its place.

When the shell finds no `node`, tell the user the plugin needs Node 20 or newer, which they install from <https://nodejs.org>, and to restart their agent after that.
