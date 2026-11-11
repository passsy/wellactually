---
name: review
description: Review changes, files, folders or projects against your Well Actually advisory board, with or without Git
---

Review the named scope against the user's advisory board and independently seek behavioral defects.
Read the host adapter beside this file (codex.md, claude-code.md, opencode.md or pi.md).
Keep reviewed product files and staging unchanged; no fixes, commits, pushes, approvals or public comments unless requested.

## Which MCP server to use

The review store is the installed **wellactually** MCP server, not a separate Findings service. In Codex its tools normally have the `mcp__wellactually__` prefix; Claude uses its installed plugin namespace. Discover `start_review` on that server. Do not route this review to another similarly named findings server, provision a service, or request external-service access. The generated restricted workers use a local `review` gateway backed by the same Well Actually store. If this server is genuinely unavailable, report that exact missing connection instead of substituting a different one.

Read [How a finding reads](finding-writing.md) before recording or revising finding titles and descriptions. Generated reviewer and proof-worker instructions embed that same guidance.

## 1. Gather information

Check the assigned directory, host project inventory and known clone locations before cloning.
Do not recursively search the home directory for a repository.
If a clone is needed, create it in the durable assigned workspace.
Review selections are tracked automatically when the session is created, suggestions after aggregation, and completed fixes per resolved finding, independent of occurrence state or other findings.
Suggestion and fix events carry priority; retries and duplicate occurrences do not add events.
Upload cycles are at least five minutes apart, and completed fixes wait at least five minutes before upload.
Do not send helpfulness ratings during a review.

Start a fresh cheap-model worker with gather-information.md, the assigned directory, supplied links/refs and the original user request verbatim.
It writes task.md and optional context.md before worktree/diff preparation.
Read the brief and show the concise problem summary.
Resolve materially ambiguous scope; retain unknown intent.
Use an available cheap model, not the review model under a cheap label.

## 2. Prepare the working tree and diff

Use scripts/review.mjs from this skill directory.
Keep the MCP server and bundled helper from the same installed plugin version throughout the run. After a plugin update, start a fresh host session so both the skill instructions and MCP connection reload. Do not resume cached old instructions with the new server or run an older helper against its store. If a schema mismatch is reported, preserve the saved review and report the affected path; do not delete it, rerun the review, or add a fallback reader.
Pass --out <dir> to preserve step-1 artifacts outside selected inputs.
Git is optional:
- Snapshot: --root <project> --files <file-or-folder>
- Supplied comparison: --root <project> --patch <comparison.patch>, optional --before-root <previous-folder>
- Local changes: --root <repo> --git local
- Committed comparison: --root <repo> --git <range-or-ref>

Local changes include staged, unstaged and relevant untracked contents.
Snapshots review current contents, not invented regressions.
Fetch exact PR facts/revisions when needed; preserve user boundaries.
Git revision reviews reuse a clean linked worktree at HEAD or create a detached worktree; local/non-Git reviews stay in the assigned directory.
Never create source/ or before/ copies.
The helper creates review checkouts beside the artifact directory, with a default under ~/.wellactually/reviews/.
Choose a durable --out directory; do not put the checkout or its authoritative .well-actually store in system temporary storage.
Read source at plan.json.root and previous Git contents with git show <base>:<path>.
Reconcile task.md with actual root/base/head and omissions.
Do not widen selected folders or initialize Git merely to enable review.
Report empty input and binary/dependency/build/symlink exclusions.

## 3. Detectors, principles and routing

Run --load-principles <dir> first.
It writes detectors-triggered.json and detectors-no-findings.json.
Follow the generated <dir>/steps/3_filter-principles.md (written during preparation from filter-principles.md beside this skill): list_principles returns current-board short descriptions/tags only; use all task/source/diff/detector context, exclude definitively irrelevant advice, keep uncertain and triggered principles.
Write principles.md with retained IDs only.
No project.md, scope.json or full-advice directory.
Do not sync mid-review.
With no board explain login/sync is required.

Run --route <dir>, with --budget only when requested.
There are no static principle groups: workers load one claimed principle at a time.
Large diffs use sets.
For Route sets, start a fresh cheap worker with the generated <dir>/steps/4_splitter.md, then run --sets <dir>.
Keep coherent feature paths and their tests together, honor setBytes, and name cross-set contracts.
Do not include omitted files.
The helper rejects oversized sets; fix them before dispatch.

## 4. Claim the session and start review workers

Initialize the local Well Actually Well Actually MCP with start_review using exact repo/target/base/PR facts. start_review writes local files and registers the loopback inbox; it does not upload repository/PR metadata or publish anything. Automatic review-event reporting is separate and follows the existing stats configuration. If a host misclassifies start_review as an external upload, inspect the installed implementation and tool annotations before asking for permission; never bypass a safeguard rejection.
Show the live MCP review card immediately, before dispatching reviewers.
start_review advertises the card resource; successful tool execution does not confirm rendering. Do not say the card is open without a host widget attachment or visual confirmation. Do not immediately call review_status to check whether it appeared: supporting hosts create another widget. The model may see only text, structured data or an Inbox link even when the host displays the card.
The card shows findings immediately. Proof workers enrich the same records with evidence and assessments; occurrences track independent progress.
Keep that one card live instead of repeatedly drawing new cards or sending model-driven polling calls.
Use get_review_session for coordinator progress checks; it does not draw another card. Call review_status when the user asks to see the card again, or for the explicit snapshot fallback in claude-code.md. Only claim a rendering limitation when the host reports an error or it has been visually confirmed; missing model-visible UI is not evidence. Always include the inbox link returned by start_review, even when inline delivery is unconfirmed.
Write tracking.json with repo, target, stable run and available:true.
Run --setup-agents <dir>.
It claims an immutable MCP session, stores its ID in tracking.json, and creates one source/principle queue per set (or all for a small change), plus a source-only crossing queue when sets exist.
Each set gets max(1,ceil(retained principles/20)) workers.
Crossing gets one.

Start generated reviewer jobs concurrently with fresh contexts, reading agents/reviewer-<job>/INSTRUCTIONS.md.
Use the host's restricted reviewer runtime: text reads/search, read-only Git, claimed principle retrieval, immediate finding creation and occurrence CRUD, claim_review_work and complete_review_work.
No project/test/build/probe execution or generic writes.
If enforcement is unavailable, stop before dispatch rather than claiming isolation.

Workers repeatedly claim, investigate and complete one item, then claim the next.
Twenty determines initial worker count, not a stopping limit.
A source item ensures holistic review once per set.
Retain supported P3/P4 findings.
complete_review_work rejects contradictory coverage immediately so the same worker corrects it before moving on; never launch a fresh full review just to fix labels.
Renew long investigations before the 15-minute lease expires.
Waiting means all remaining work belongs to other workers: exit without polling.
Failed/context-exhausted workers can be replaced using their worker identity or an expired claim.
Never silently mark abandoned work done.

Wait for all workers and require --check <dir> --stage review.
Use get_review_session for incomplete claims.
Queues, claims, coverage and findings belong in MCP under <repo>/.well-actually; never create local verdicts/, verified/, findings.json, ratings.json or a shadow store.
MCP must be available.

## 5. Aggregate similar issues

After review completion, start one fresh agent with agents/aggregator/INSTRUCTIONS.md.
It only groups findings describing the same concrete issue.
It does not test, prove, dismiss or change lifecycle state.
It partitions every finding exactly once via begin_verification; uncertain groups remain singleton.
Grouping stays in MCP.

## 6. Verify through the proof queue

Run --setup-verifiers <dir> after aggregation.
With Git, it creates ceil(unique issue groups/10) verification workers, each in its own detached proof worktree.
Local/patch/snapshot contents are overlaid so a HEAD-only checkout cannot silently drop reviewed changes.
Without Git, use one verifier in the assigned directory.
Zero issues needs zero workers.
Start generated agents/verification-worker-<n>/INSTRUCTIONS.md with fresh contexts and execution/probe permissions.
There is no tester.

Proof workers claim issue groups, check grouping and source/advice, attempt focused executable proof for behavioral claims, then immediately complete_review_work with decisions, proof references and limits.
Every surviving decision must include method (source, executable or unverified) and finding:{evidence,anchor}, using the checked current source location.
Executable proof also requires finding.provenTest and a proof reference.
Use method source with Reasoned evidence for source-supported claims, and method unverified with plausible status and an explicit dependency for unresolved claims.
A partial or copied-path probe does not prove an unexecuted production path.
Submit corrected title/body/anchor fields inside finding, rather than mentioning corrections only in prose.
The server persists the final assessment, proof references and limits on the finding before completing the item.
Static/style/API/coverage findings may use source evidence.
Proven requires an actual focused failing production-path probe; a fake does not establish hardware behavior.
Keep useful Reasoned/Speculative claims explicit.
Product files remain unchanged; use disposable probe copies where needed and separate per-issue proof directories.

Follow the host adapter for proof execution: Claude uses native Agent workers inheriting parent permissions; Codex passes its actual sandbox policy through the launcher. Reviewer permissions stay read-only.
If infrastructure is corrected after an issue completed, the coordinator may call retry_verification with selected issue IDs and a reason.
Prior attempts and finding IDs are retained, worker count is ceil(retried issues/10), and only those proofs rerun.
Never restart the whole review or silently omit the original blocked work from the report.

Use the host adapter's reviewer pool and its proof mechanism. CLI pools recover ordinary crashes with at most two fresh-context replacements per worker, preserving identity and durable claims. Claude proof workers use the native Agent tool instead of the CLI proof pool.
Preserve attempt audits.
Cancellation stops the pool.
Explicit safeguard/policy rejections block the affected item and must never be replayed through a replacement; healthy workers may continue other eligible items.
A blocked item keeps the final gate incomplete.
The non-Git single-verifier cap also applies to retries.

Blocked proof findings remain accessible in Well Actually MCP and the findings view, with an assessment describing the blocked investigation, source location and original explanation.
The block is about the verification request, not proof that the code has a security defect.
Human verdicts stay unchanged; existing executable proof is not erased by a blocked later attempt.

Wait for all workers and require --check <dir> --stage verify plus saved assessments for every completed investigation.
The gate checks final evidence, locations and proof/limit persistence against the published findings, not just queue completion.
Read authoritative session/findings; no finalizer/report worker.
Retain coverage and platform limits.
Aggregation saves one retry-safe suggestion per distinct issue and attributed principle in the MCP session.
Reporting starts automatically after begin_verification and retries with normal detection uploads.
Do not report raw findings, individual occurrences, review selections or helpfulness ratings.
At completion, call report_review_suggestions once to upload eligible pending events within the five-minute throttle; an upload failure must not block review delivery.
Read get_review_session for suggestion delivery status; never create a local telemetry or findings shadow file.
On incomplete coverage leave baseline untouched.
After complete coverage, call baseline_check once with currentFindingIds containing every surviving finding ID from this run, including metadata findings.
This reconciles previously saved findings with this run; it does not execute tests or prove a defect is fixed. Absence from a review is not executable proof.
Do not reconstruct metadata findings as source-file anchors.
Keep human verdicts undecided/unresolved.

Present verdict, concrete findings, a concise solution assessment where relevant and proof limits, with artifact/MCP links.
Include elapsed time, stage durations or timing tables only when the user asks for them.
Infrastructure failures are not product defects.
Node 20+ is required.
