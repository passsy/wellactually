---
name: review
description: Review a change, a branch or a pull request against every principle on your Well Actually advisory board
---

Review the named change against the user's advisory board and independently seek behavioral defects.
Coordinate workers with fresh contexts. Do not read source, diff or principle advice into this conversation when subagents are available.
Read the host adapter next to this file: `claude-code.md`, `codex.md`, `opencode.md` or `pi.md`.

## 1. Prepare and route mechanically

From the repository run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/wellactually.mjs" review [target]
```

Use the named local changes, branch, range or pull request. With no target, use local changes, or the branch against the default branch when clean.
Targets include `main...HEAD`, `a..b` or a single ref. For a PR, fetch its base and head without switching branches, then review the fetched base against the exact head SHA.
The printed review directory `<dir>` holds immutable target metadata, diff parts, advice and worker instructions.
Only generated files are excluded. On an empty change stop. With no advisory board, explain that login/sync is required; with all principles excluded, exploratory testing and verification still run.

Run immediately, without a router worker:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/wellactually.mjs" review --route <dir>
```

All board principles are assigned by default; reviewers mark irrelevant advice `not_applicable`.
An optional existing `scope.json` is honored, and unclassified principles remain included.
Pass `--budget` only when the user specifies a context budget.
For `Route: sets` only, start a cheap-model worker: "Read `<dir>/steps/splitter.md` and split the review in `<dir>`." Then run `review --sets <dir>` and repair invalid sets before proceeding.

Initialize findings tracking as described in `<dir>/steps/findings.md`; retain the original target URL and task in `task.md` for workers, with no prior findings or review comments.
No context, blind-design, map or investigation worker/document is required.

## 2. Review and explore concurrently

Start these workers together, with the review model and almost empty contexts:

- One per job in `jobs.json`: "Read `<dir>/steps/reviewer.md` and do job `<id>` in `<dir>`."
- One exploratory tester per unit: "Read `<dir>/steps/testing.md` and test unit `<unit>` in `<dir>`."
- With sets, one crossing reviewer too: "Read `<dir>/steps/reviewer.md` and do the crossing pass in `<dir>`."

Without sets the only unit is `all`; otherwise units are each set ID plus `crossing`.
Even zero principle jobs still need an exploratory tester.
Reviewers challenge implementation choices and trace ownership within their own work. Testers independently develop falsifiable hypotheses from changed behavior and existing assertions. Neither waits for the other or reads the other's results.
Avoid mandatory exhaustive inventories and routine broad suite replays. For ordinary changes, aim for roughly five minutes for this wave; this is prioritization guidance, not permission to omit required verdicts or conceal unresolved checks.

Wait for both review and testing, then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/wellactually.mjs" review --check <dir> --stage test
```

Send missing/invalid outputs to their responsible workers once. If still incomplete, disclose it and do not claim complete coverage.

## 3. Verify once

Start one fresh verifier per unit, all together: "Read `<dir>/steps/verifier.md` and verify unit `<unit>` in `<dir>`."
It checks every review/testing candidate for that unit; zero candidates require an independent challenge.
Aim for roughly two minutes for ordinary changes, focusing on disputed assumptions and evidence instead of repeating the whole review.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/wellactually.mjs" review --check <dir> --stage verify
```

Repair gaps before reporting completion. A successful worker exit is not a completion check.

## 4. Finalize mechanically, track and present

No report worker. Run the skill-local helper:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/review/scripts/finalize.mjs" <dir>
```

It checks completion, joins candidate references to verification, preserves scopes/evidence, merges only clearly identical defects, and writes `findings.json`, `report.md` and `ratings.json`.
For OpenCode/pi installations the script lives beside this skill in `scripts/finalize.mjs`; use that path.
Read only these final files for the user-facing result. Follow `steps/findings.md` to record surviving findings through MCP and attach returned IDs; never hand-edit MCP storage or set human triage decisions.
Send each entry in `ratings.json` once with the MCP `rate_principle` tool. If ratings/tracking are unavailable, record that limitation in the report. Do not sync the board mid-review.
Run `review --check <dir> --stage report` after tracking and present the concise report with its artifact path and material limitations.
Do not reread all worker documents or rewrite a long narrative. The report links test results for details.

## Permissions and failures

Workers may read repository files and callers, execute local checks, and create probes or alter tests in disposable copies. Give them file/shell tools needed for those tasks within host permissions.
Keep the reviewed working tree unchanged. Never fix product code or post PR comments unless asked.
When a runtime, dependency or permission is unavailable, record the blocked check and continue independent work; do not call infrastructure failure a product defect.
If a check or required artifact remains missing, report an incomplete review and its precise gap.
`${CLAUDE_PLUGIN_ROOT}` means the nearest ancestor of this skill containing `dist/wellactually.mjs` when the host does not set it.
If Node is absent, explain that the plugin requires Node 20 or newer from <https://nodejs.org> and restarting the agent.
