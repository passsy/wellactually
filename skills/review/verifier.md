# Aggregate and verify the review

Follow the shared **How a finding reads** guidance in your generated instructions (or read `finding-writing.md` beside this file). Apply it to both the title and description; keep investigation detail in evidence and assessments.

You are the single verifier for the whole review in <dir>. Start only after every reviewer, including any crossing reviewer, has finished. Do not spawn more verifiers or testers.

Read task.md, optional context.md, plan.json, jobs.json, all reviewer verdicts, and the assigned diff parts. Read production source and callers directly from plan.root; use git show for previous Git contents. Keep product files, branch and staging unchanged.

## Aggregate candidates first

Read tracking.json and use list_findings for this run across all units. Read findings.md for the CRUD model and independent occurrences. Check every finding ID in reviewer verdicts exists. Load full principle advice with MCP get_principle using IDs and versions from plan.json.
Group findings describing the same defect across reviewers or change sets before reproducing them. Verify each distinct defect once. Keep distinct defects separate even when they share a line. Consolidate duplicates with CRUD, preserving distinct occurrences and closing originals as superseded with links to the surviving record. Never disprove a claim merely because it is duplicated.

## Establish evidence

For each distinct claim, trace the actual production path and develop a focused falsifiable probe when execution can settle it. Reviewers deliberately did not execute code: missing proof is your work, not a reason to dismiss a candidate.
Use <dir>/probes/verification/ for scripts, logs and results.md. If a test needs product changes, use a disposable Git worktree or a minimal disposable non-Git copy. Never create shared source/ or before/ snapshots. Use available runtimes and local test resources, not production services or data.
Run the real production entry point, not a reimplementation. Retain the command, input, expected/actual results, exit status and reproduction output. Where useful, compare identical fixtures on base and head. Do not replay broad suites unless they resolve a specific claim.
For behavioral defects, attempt executable proof. For static/API/style findings and coverage gaps, appropriate source or configuration evidence may settle the claim without execution. Keep P3/P4 findings when supported. A blocked runtime or failing fixture is a limitation, not proof of a product defect.

Check scope, mechanism and principle applicability. Decide confirmed, plausible (requires unresolved dependency/reason), or refuted (requires specific counter-evidence). Confirming a source argument does not make it Proven. Upgrade evidence to Proven only after an actual failing production-path probe. Attach a proof the reader can understand and reproduce: a runnable test/probe source file, or a Markdown document with the complete test/reproduction, exact run command, prerequisites, expected and actual results, and limitations. Prefer one self-contained proof per distinct claim. If a probe needs production mutations, include the exact changes and how to reproduce them in that Markdown document. Keep raw stdout/stderr logs, grep/baseline dumps and standalone .diff/.patch files in the working directory; do not add them to evidence.artifacts or the completion proofs list. Summarize only the decisive output in the document. A blocked or unexecuted test belongs in the limitations, not as executable proof.
Save evidence and assessments immediately with update_finding/update_occurrence and expectedRevision. Save independent discoveries through create_finding/create_occurrence. No promotion or verification status is required. Never stage finding records in local JSON.

## Audit reviewer coverage

Audit every reviewer's principle questions and evidence, including followed and not_applicable. Return unsupported answers to the owner; preserve unresolved limits explicitly.
Write investigations/<unit>.json for each unit (set IDs plus crossing, or all) with one {job, principle, status: checked|limited, reason, limits} entry per principle verdict. This is coverage evidence, not a findings store.
For each unit with zero candidates, independently challenge a meaningful failure hypothesis and write challenges/<unit>.md with the production trace/probe and limitations.

## Complete

Write probes/verification/results.md summarizing unique claims investigated, commands/results, deduplication references and unresolved limits. The authoritative findings and decisions remain in MCP.
Read the run findings again and require saved assessments for every completed investigation. Do not fabricate human assessments, post comments or fix product code. Report evidence, superseded/disproven records and execution/coverage limitations.

Proof artifact paths saved through the Well Actually MCP must be absolute for files outside the reviewed repository. The Codex proof gateway expands review-relative paths; direct MCP calls have no review-directory context and must use absolute paths. Keep source location paths relative to the reviewed repository.
