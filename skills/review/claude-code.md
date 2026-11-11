# Running the review in Claude Code

Start fresh information-gathering and optional splitter agents with the Agent tool, `subagent_type: general-purpose`, and `model: haiku`.
Start one fresh aggregation-only agent with the session's model after the review gate passes.
Aggregated suggestions are reported automatically; do not rate principles during the review.
Tell all child agents not to call either rating tool.

## Findings delivery

Inline findings cards are temporarily disabled in Claude because their refresh and voting calls fail.
Use start_review to register the review and share its browser inbox link at the start and in the final report.
Use get_review_session for progress checks. review_status returns a text summary without a card.
Do not draw startup, progress, final or replacement cards, or ask the user to retry a card.
Viewing findings, voting and notes use the browser inbox. Keep the MCP server in the coding session's normal lifecycle; do not install a separate Desktop connector.

## Restricted review pool

Use the bundled launcher for read-only reviewers. Pass the session's exact model and effort.

```bash
node "<skill>/scripts/review.mjs" --run-reviewers <dir> --provider claude --model <session-model> --effort <session-effort>
```

The reviewer launcher disables built-in tools, hooks, skills, session persistence and user/project setting sources.
Its strict MCP configuration exposes only the assigned read-only review gateway and finding/coverage writes.
Reviewers cannot execute code or make generic writes.
Do not replace a failed restricted launch with an unrestricted reviewer.
The pool replaces ordinary dead workers at most twice using the same identity and durable claim. It never replays an explicit safeguard rejection.

## Native proof workers

After --setup-verifiers <dir>, start each generated agents/verification-worker-<n>/INSTRUCTIONS.md assignment through Claude's native Agent tool with subagent_type: general-purpose and run_in_background:false. Omit model to inherit the session's model; inherit its effort and permissions too.
Do not run --run-verifiers or --run-verifier with --provider claude. Do not start a separate Claude CLI process for proof work or request danger-full-access, bypassPermissions, extra allow rules, disabled hooks or removed settings.
Native proof agents use the parent's existing Well Actually MCP tools directly, with explicit repo, target, session, queue and worker arguments from the assignment and tracking.json. The generated proof working root is already prepared; do not request another worktree.
Give each agent this task:

> Read and follow <absolute INSTRUCTIONS.md path>. Investigate the assigned findings in the generated proof working root. Run focused tests under the parent session's existing permissions. Use the inherited Well Actually MCP tools to save evidence and assessments and complete queue work. Preserve human verdicts, notes and unrelated findings. Do not spawn agents or rate principles. Report blocked actions and proof limits.

A native proof agent inherits the parent's available tools; it does not use the CLI launcher's restricted MCP gateway. Assignment scope is instructed rather than enforced by that gateway. Keep the read-only reviewer isolation separate from proof execution.
If a native agent exhausts context or crashes, inspect authoritative claims and saved work before replacing it with the same worker identity. Never replay a user or safeguard rejection, switch providers/models or widen permissions without an explicit user request. Preserve source findings and record blocked executable verification as a limit.
Read the project's pinned runtime configuration before installing dependencies or running probes.
Wait for native Agent results, then require --check <dir> --stage verify. A successful agent report alone does not satisfy the gate.

After investigation, use saved finding IDs for baseline reconciliation and the MCP session for suggestion delivery status.
Read queue counts first. Inspect one queue and, when needed, one item with get_review_session(includeResults:true, queue, item); do not repeatedly request the full session when its output exceeds the host limit.
Report proof limits, pending or blocked work and replacements.

Proof artifact paths saved through the Well Actually MCP must be absolute for files outside the reviewed repository. The Codex proof gateway expands review-relative paths; direct MCP calls have no review-directory context and must use absolute paths. Keep source location paths relative to the reviewed repository.
