---
name: apply-review-fixes
description: Fix accepted or explicitly selected Well Actually findings, verify the changes, record fix commits and explicitly close completed findings in the original review store. Use when asked to fix findings or work through an accepted review queue.
---

# Fix findings and record completion

Fix the selected issues and update their saved lifecycle before reporting them done. A commit link records work; it never resolves a finding automatically. Multiple commits can be partial progress.

## Find the actual review and scope

Use the repo and target supplied by the review card or tracking.json. Otherwise discover the review with list_reviews; do not guess a target such as pr-9 or assume the product checkout owns the findings. A review may live in a separate checkout. Keep its store address when making changes in the product checkout.
Read get_finding and list_occurrences for each selected finding, including its rules, evidence, assessments, user verdict, notes and existing work links. For an accepted queue, select state:open and verdict:accepted. Explicit user selections also authorize their named findings. Preserve tolerated, rejected, undecided and unrelated findings unless selected by the user.
Confirm the current source and the full linked principle advice with get_principle before editing. Honor user notes and current requirements. If deployment facts or source disprove the claim, record that assessment and close with reason:disproven rather than inventing a fix. Preserve the user's verdict.

## Apply and verify

Make the smallest complete fix in the product checkout. Run the relevant behavior tests and the project's required checks using its existing runtime. Record the commands, results and any limits. Do not claim completion from a commit message, an absent review result or an unrun test.
When commits are part of the requested workflow, keep one coherent issue per commit and use the actual full SHA. A finding may need several commits. A request to fix findings does not itself authorize pushing, posting comments, changing a PR, deploying or altering production data; honor any authorization already given in the session.

## Save work and closure explicitly

Re-read the latest finding before every update. Use update_finding with its expectedRevision; retain existing IDs and unrelated entries when replacing arrays.

For a complete verified fix, append its commit links and an agent assessment documenting verification, and set state:closed plus closure:{reason:resolved,explanation:"What changed and how it was checked"} in the same update. Include every fix commit, not just the last one. Preserve verdict, reportedAt, the user note and existing evidence/work links. Never create a human assessment.
For partial work, append links and verification details while leaving the finding open. Resolve the occurrences actually checked with update_occurrence, preserving their links and history; unaddressed occurrences remain open. The finding can also be explicitly resolved independently of occurrence state. Occurrence bookkeeping is not a prerequisite for closing a verified finding or reporting its fixed event.
A duplicate should be consolidated into one canonical finding with its occurrences; superseded originals are history, not additional resolved fixes. Do not close unrelated findings merely because they belonged to an old verification group.
If a write conflicts, re-read and reconcile it. If a response is lost, read the saved record before retrying so links and assessments are not duplicated. A successful code fix with failed bookkeeping is incomplete; retry the record update and report any remaining failure.

## Completion check

Before the final answer, read back every selected finding with get_finding. Each must be resolved, disproven, superseded, or explicitly listed as still open with the remaining work or blocker. Verify that the saved links contain the actual fix SHAs and that the user's verdict and note are preserved. Never say a finding is done while its saved state is open.
Report fixed IDs and commits, skipped/open findings and reasons, and actual validation. Fixed telemetry follows the finding's resolution after the five-minute grace and normal upload cycle; closure alone does not prove remote delivery. No extra review_status call is needed to check bookkeeping.
