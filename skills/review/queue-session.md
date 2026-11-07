# MCP is the review workspace

Show the MCP review card when start_review creates the target, before reviewers start.
If the host did not draw it, call review_status once with the same repo and target.
Pending candidates appear as unverified and update as verification proceeds.
Let the card refresh itself; do not poll through the coordinator or create a new card for every finding.
Use the provider-specific inbox URL as the fallback when the host cannot display MCP Apps.

Call start_review with repo=plan.json.root, a stable target, the actual comparison base when present and known PR facts only. Write tracking.json with repo,target,run,available:true. Run --setup-agents to claim the immutable review session and record its ID in tracking.json. One queue per set contains retained pinned principles and one holistic source item. No excluded principle is sent to workers.

Workers use claim_review_work and complete_review_work. Server-validated coverage, lease recovery, grouping and candidate decisions stay in MCP under the repo's .well-actually directory. Do not write local verdicts, findings, ratings or verification JSON. Missing MCP is a blocker, not permission for a shadow store.

After all review items complete, the aggregation-only agent uses begin_verification to partition every candidate by issue. Run --setup-verifiers and dispatch its generated workers. Claims and completions are durable and idempotent; never treat a process exit as queue completion. Final verification requires all items complete and zero pending candidates. Human verdicts remain undecided/unresolved. Baseline reconciliation requires complete coverage; otherwise leave it untouched.
