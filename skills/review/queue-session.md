# MCP is the review workspace

Show the MCP review card when start_review creates the target, before reviewers start.
start_review advertises a card resource; tool success alone does not confirm rendering. Do not claim the card is open without a host widget attachment or visual confirmation. Do not follow it with review_status to check rendering: supporting hosts create a second widget. Model-visible text or an Inbox link does not tell you whether the host drew the card.
Findings appear immediately and gain evidence/assessments as investigation proceeds.
Let the card refresh itself. Use get_review_session for coordinator progress checks; do not create another card to check progress or for every finding. Use review_status on the user's request, or the explicit non-refreshing-host fallback in claude-code.md.
Always include the provider-specific inbox URL returned by start_review. Only claim that MCP Apps did not render when the host reports an error or it has been visually confirmed.

Call start_review with repo=plan.json.root, a stable target, the actual comparison base when present and known PR facts only. Write tracking.json with repo,target,run,available:true. Run --setup-agents to claim the immutable review session and record its ID in tracking.json. One queue per set contains retained pinned principles and one holistic source item. No excluded principle is sent to workers.

Workers use claim_review_work and complete_review_work. Server-validated coverage, lease recovery, grouping and saved finding assessments stay in MCP under the repo's .well-actually directory. Do not write local verdicts, findings, ratings or verification JSON. Missing MCP is a blocker, not permission for a shadow store.

After all review items complete, the aggregation-only agent uses begin_verification to partition every finding by issue. Run --setup-verifiers and dispatch its generated workers. Claims and completions are durable and idempotent; never treat a process exit as queue completion. Final verification requires all items complete and saved assessments for every completed investigation. Human verdicts remain undecided/unresolved. Baseline reconciliation requires complete coverage; otherwise leave it untouched.
