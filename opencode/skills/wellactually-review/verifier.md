# Aggregate and verify the review

You are the single verifier for the whole review in <dir>. Start only after every reviewer, including any crossing reviewer, has finished. Do not spawn more verifiers or testers.

Read task.md, optional context.md, plan.json, jobs.json, all reviewer verdicts, and the assigned diff parts. Read production source and callers directly from plan.root; use git show for previous Git contents. Keep product files, branch and staging unchanged.

## Aggregate candidates first

Read tracking.json and list every candidate for this run through Findings MCP, across all units. Check every candidate ID in reviewer verdicts exists. Load full principle advice with MCP get_principle using IDs and versions from plan.json.
Group candidates describing the same defect across reviewers or change sets before reproducing them. Verify each distinct defect once. Keep distinct defects separate even when they share a line. Consolidate duplicates into one finding using MCP corrections/related locations; record duplicate-only disposition explicitly if the MCP requires refuting a redundant candidate. Never reject its substantive claim merely because it is duplicated.

## Establish evidence

For each distinct claim, trace the actual production path and develop a focused falsifiable probe when execution can settle it. Reviewers deliberately did not execute code: missing proof is your work, not a reason to dismiss a candidate.
Use <dir>/probes/verification/ for scripts, logs and results.md. If a test needs product changes, use a disposable Git worktree or a minimal disposable non-Git copy. Never create shared source/ or before/ snapshots. Use available runtimes and local test resources, not production services or data.
Run the real production entry point, not a reimplementation. Retain the command, input, expected/actual results, exit status and reproduction output. Where useful, compare identical fixtures on base and head. Do not replay broad suites unless they resolve a specific claim.
For behavioral defects, attempt executable proof. For static/API/style findings and coverage gaps, appropriate source or configuration evidence may settle the claim without execution. Keep P3/P4 findings when supported. A blocked runtime or failing fixture is a limitation, not proof of a product defect.

Check scope, mechanism and principle applicability. Decide confirmed, plausible (requires unresolved dependency/reason), or refuted (requires specific counter-evidence). Confirming a source argument does not make it Proven. Upgrade evidence to Proven only after an actual failing production-path probe, with provenTest containing the command, expected/actual result and artifact paths.
Record decisions immediately through resolve_candidates; confirmed/plausible candidates become undecided/unresolved human-triage findings. Save independent discoveries through create_candidates then resolve them. Never stage finding bodies or verification decisions in local JSON.

## Audit reviewer coverage

Audit every reviewer's principle questions and evidence, including followed and not_applicable. Return unsupported answers to the owner; preserve unresolved limits explicitly.
Write investigations/<unit>.json for each unit (set IDs plus crossing, or all) with one {job, principle, status: checked|limited, reason, limits} entry per principle verdict. This is coverage evidence, not a findings store.
For each unit with zero candidates, independently challenge a meaningful failure hypothesis and write challenges/<unit>.md with the production trace/probe and limitations.

## Complete

Write probes/verification/results.md summarizing unique claims investigated, commands/results, deduplication references and unresolved limits. The authoritative findings and decisions remain in MCP.
List candidates for the run again and correct errors until zero remain pending. Leave human verdicts undecided. Do not post comments or fix product code. Reply with counts of confirmed, plausible, refuted and duplicate candidates, plus execution/coverage limitations.
