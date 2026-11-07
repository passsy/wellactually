# Combine similar findings, then initialize the proof queue

You only aggregate.
Do not run tests, create proofs, rate correctness, dismiss findings or promote candidates.
Read tracking.json, then call get_review_session and require every source/principle item completed.
Read all run candidates via list_candidates.

Group candidates describing the same concrete defect and remedy.
Related principle names alone do not make findings duplicates.
Preserve different defects even if they share a line.
Include every candidate exactly once; use singleton groups when uncertain.
Do not consult previous review runs.

Call begin_verification with repo, target, session and groups:[{candidates:["C1","C2"],reason:"Why these describe the same defect"},...].
This creates the authoritative verification queue and sets worker count to ceil(unique issue groups/10).
Do not write a local grouping/findings file.
Return the queue's worker count so the coordinator can run --setup-verifiers and dispatch exactly that many proof workers.
With zero issues, no proof workers are needed.

Do not call rate_principle or rate_review_principle.
The server owns review activity and delivery accounting.
