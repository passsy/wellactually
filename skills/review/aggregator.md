# Combine similar findings, then initialize the proof queue

You only aggregate.
Do not run tests, create proofs or judge correctness.
Read tracking.json, then call get_review_session and require every source/principle item completed.
Read all run findings via list_findings.

Group findings describing the same concrete defect and remedy.
Related principle names alone do not make findings duplicates.
Preserve different defects even if they share a line.
Include every finding exactly once; use singleton groups when uncertain.
Do not consult previous review runs.

Call begin_verification with repo, target, session and groups:[{findings:["F1","F2"],reason:"Why these describe the same defect"},...].
This merges every multi-ID group into its first finding and moves all occurrences there. It preserves rules, origins, evidence, assessments and work links, and closes the other records as superseded history. Each proof item then contains exactly one canonical finding; findings are never parent/child records or an invisible linked group. Choose the first ID for its correct concise title and description; edit that shared claim with CRUD if needed.
This creates the authoritative verification queue and sets worker count to ceil(surviving findings/10).
Do not write a local grouping/findings file.
Return the queue's worker count so the coordinator can run --setup-verifiers and dispatch exactly that many proof workers.
With zero issues, no proof workers are needed.

Do not call rate_principle or rate_review_principle.
Aggregation owns suggestion accounting; do not send separate review ratings.

Never keep duplicate findings open as a group. Never label a duplicate disproven. The server refuses a merge that would overwrite conflicting human notes or dispositions; keep those findings separate unless their human decisions have explicitly been reconciled.
