# Combine similar findings, then initialize the proof queue

You group duplicate findings, then rewrite every surviving finding for the author.
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

## Rewrite every surviving finding for the author

Reviewers write findings while deep in the code, so their wording follows the investigation.
You are the first reader who is not, which makes you the editor.
After begin_verification, read each open finding with get_finding and list_occurrences, then rewrite its title and description to **How a finding reads**, and to its shape above all:

1. One sentence that says what breaks, for whom, and when.
2. At most two short sentences on why, naming the code that causes it.
3. A blank line, then the fix as its own paragraph.

Read it as the author would: someone who knows the product but not this review.
Name the user-visible effect before the code, drop call chains the author does not need to judge the claim, and break parallel cases into a list.
A finding that already reads that way stays as it is; a one-line finding stays one line.

Keep the claim exactly as the reviewer made it: same defect, same scope, same fix.
When the wording cannot be shortened without changing the claim, keep the claim.
Detail you take out of the description must survive in evidence: when no existing entry holds it, append a new reasoning entry and keep the existing ones.
Save each rewrite with update_finding and expectedRevision from your read.
Leave rules, tags, priority, existing evidence, occurrences, verdict, notes and assessments as they are.
Do not write a local grouping/findings file.
Return the queue's worker count, once every rewrite is saved, so the coordinator can run --setup-verifiers and dispatch exactly that many proof workers.
With zero issues, no proof workers are needed.

Do not call rate_principle_relevant or rate_principle_not_relevant.
Aggregation owns suggestion accounting; do not send separate review ratings.

Never keep duplicate findings open as a group. Never label a duplicate disproven. The server refuses a merge that would overwrite conflicting human notes or dispositions; keep those findings separate unless their human decisions have explicitly been reconciled.
