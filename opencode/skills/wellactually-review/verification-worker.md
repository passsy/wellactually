# Verify from the shared proof queue

Use Findings MCP directly.
Read tracking.json; call claim_review_work with repo, target, session, queue verification and your worker id.
Keep claiming until complete, waiting (all remaining eligible items owned) or blocked (uncompleted blocked items remain).
Do not poll or replay a blocked item.
Renew long claims with the same call before the 15-minute lease expires.
Run from the generated proof working root: each Git worker has its own worktree; non-Git reviews use one worker in the assigned directory.
Keep generated build state inside that root and your issue's proof directory.

Do not use real devices or production services without explicit authorization.
Do not install heavy unavailable runtimes or copy whole SDKs to defeat a permission boundary; retain the blocked check and continue independent issues.
Normal disposable fixtures and existing local runtimes are appropriate.

Each claimed item is one deduplicated issue with candidate IDs and grouping rationale.
Load those candidates via list_candidates and relevant full principle advice using pinned versions in plan.json.
Independently verify the claim and check the aggregator's grouping; related but different defects must each survive.
Inspect production source and base paths.
Only proof workers may execute tests/probes.
Keep reviewed tracked files and staging unchanged; use disposable probe/test copies when needed.

Behavioral findings require a focused executable proof attempt through the real production entry point.
Retain commands, input, expected/actual results, exit status and output under <dir>/probes/verification/<issue-id>/<claim-token>/ so lease recovery cannot overwrite another attempt.
Static/style/API and missing-test claims may be settled by source/configuration evidence.
Keep small supported findings.
Blocked infrastructure is a limit, never evidence of a defect.
Platform fakes do not establish real hardware behavior.
Proven requires an actual failing production-path probe and provenTest identifying it; agreement alone stays Reasoned.

Complete each issue immediately using complete_review_work with repo,target,session,queue,worker,item,claim and result:{summary,proofs:[artifact paths or source evidence],limits:[],decisions:[{id,status,reason,method,proof?,finding:{evidence,anchor,provenTest?,title?,body?}},...]}.
For confirmed/plausible candidates, method and finding with explicit evidence and a checked anchor are mandatory.
Use method executable only with a focused failing production-path probe, evidence Proven, provenTest and proof.
Use method source with evidence Reasoned for source-supported claims, or method unverified with plausible status and the unresolved dependency.
Partial reproductions must leave unexecuted claims Reasoned/Speculative.
Include corrected locations and wording in finding so the saved record changes immediately.
Do not leave a known wrong anchor or evidence label for the coordinator to explain in chat.
Read the pinned runtime configuration before resolving dependencies; do not start with an unrelated global SDK.
For an introduced-regression claim, compare the relevant base path or explicitly retain the untested base as a limit.
Do not rate principles; the coordinator owns session ratings.
Decisions must cover every candidate in the claimed issue exactly once.
confirmed/plausible promotes an undecided/unresolved finding; plausible requires the unresolved dependency.
A duplicate member may be refuted only with an explicit duplicate reason pointing to the retained candidate; do not refute its substantive claim.
If the grouping combined distinct defects, retain each separately.
The server resolves all candidate decisions and saves completion; do not call resolve_candidates separately.
Correct indexed validation errors within this conversation.

The session holds all coverage, decisions and grouping.
Write only proof artifacts, never findings.json, verified JSON or a second summary ledger.
Claim another issue after each completion.
Do not stop after ten issues: ten determines initial worker count.
Finish your claim and request replacement if context fills.
Leave human verdicts undecided.
Return completed issue count and remaining proof limits.
