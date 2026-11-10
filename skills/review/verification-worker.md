# Verify from the shared proof queue

Follow the shared **How a finding reads** guidance in your generated instructions (or read `finding-writing.md` beside this file). Apply it to both the title and description; keep investigation detail in evidence and assessments.

Use Well Actually MCP directly.
Read tracking.json; call claim_review_work with repo, target, session, queue verification and your worker id.
Keep claiming until complete, waiting (all remaining eligible items owned) or blocked (uncompleted blocked items remain).
Do not poll or replay a blocked item.
Renew long claims with the same call before the 15-minute lease expires.
Run from the generated proof working root: each Git worker has its own worktree; non-Git reviews use one worker in the assigned directory.
Keep generated build state inside that root and your issue's proof directory.

Do not use real devices or production services without explicit authorization.
Do not install heavy unavailable runtimes or copy whole SDKs to defeat a permission boundary; retain the blocked check and continue independent issues.
Normal disposable fixtures and existing local runtimes are appropriate.

Each new claimed item contains one canonical finding and the rationale for consolidating its occurrences. Older saved sessions may still assign several findings; investigate those independently. Load list_findings/get_finding and list_occurrences from the assigned gateway or, for native Claude agents, the inherited Well Actually MCP with explicit repo/target arguments. Retrieve the relevant full pinned advice.
Independently investigate the shared claim and each occurrence it covers. Findings already exist; investigation adds information rather than promoting them.
Inspect production source/base paths. Only proof workers may execute tests/probes. Keep reviewed tracked files and staging unchanged; use disposable probe/test copies.
Retain working files under <dir>/probes/verification/<issue-id>/<claim-token>/.
Attach a proof the reader can understand and reproduce: a runnable test/probe source file, or a Markdown document with the complete test/reproduction, exact run command, prerequisites, expected and actual results, and limitations. Prefer one self-contained proof per distinct claim. If a probe needs production mutations, include the exact changes and how to reproduce them in that Markdown document. Keep raw stdout/stderr logs, grep/baseline dumps and standalone .diff/.patch files in the working directory; do not add them to evidence.artifacts or the completion proofs list. Summarize only the decisive output in the document. A blocked or unexecuted test belongs in the limitations, not as executable proof.
Behavioral claims deserve a focused production-path proof attempt. Source-observable rule violations may already be established by source. Blocked infrastructure is a limit, never evidence of a defect; platform fakes do not establish hardware behavior.

Persist evidence and assessments with update_finding/update_occurrence and expectedRevision from the latest read. Arrays replace collections; preserve prior entries and their IDs. Evidence has kind source/reasoning/test, polarity supports/contradicts, description and artifacts. Scope evidence to occurrenceIds when it proves only some instances. Every assessment requires all four fields: `author` (your worker ID), `authorType:"agent"`, `conclusion` (your judgment) and `reason` (what you checked, why it supports the judgment, and any limits). For example: `{author:"verification-worker-1",authorType:"agent",conclusion:"Source supports the claim",reason:"Checked both occurrences against the pinned advice; runtime behavior was not tested"}`. Read back the assigned assessment IDs before completing the issue. Do not edit human assessments or notes.
If evidence disproves the claim, record it and close the finding with closure reason disproven. Other findings can remain open with source evidence or reasoning alone. Correct wrong wording and locations in place. Do not set a verification status or a confidence score.
Do not treat duplicates as disproof. Consolidation and superseded links preserve the original claims. Distinct defects must survive separately.
Read the pinned runtime configuration before resolving dependencies. Compare the base path for introduced regressions or retain the untested base as a limit. Do not rate principles.

Complete each issue with complete_review_work and result:{summary,proofs:[runnable test/probe or Markdown proof paths; source references for source-only checks],limits:[],decisions:[{id,revision,assessmentIds:[saved assessment IDs],evidenceIds:[saved evidence IDs]},...]}.
Cover every assigned finding exactly once, including superseded or disproven records. Save assessments/evidence before completion. Completion only accounts for work; it does not change finding lifecycle. If rejected, correct the submission within this conversation.

The session holds all coverage, decisions and consolidation rationale.
Write only proof artifacts, never findings.json, verified JSON or a second summary ledger.
Claim another issue after each completion.
Do not stop after ten issues: ten determines initial worker count.
Finish your claim and request replacement if context fills.
Do not fabricate human assessments.
Return completed issue count and remaining proof limits.

Proof artifact paths saved through the Well Actually MCP must be absolute for files outside the reviewed repository. The Codex proof gateway expands review-relative paths; direct MCP calls have no review-directory context and must use absolute paths. Keep source location paths relative to the reviewed repository.
