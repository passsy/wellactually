# Running the review in Claude Code

Start fresh information-gathering and optional splitter agents with the Agent tool, `subagent_type: general-purpose`, and `model: haiku`.
Start one fresh aggregation-only agent with the session's model after the review gate passes.
Aggregated suggestions are reported automatically; do not rate principles during the review.
Tell all child agents not to call either rating tool.

## Review card updates

Claude Desktop can render an inline MCP App even when its card-to-server tool calls are unavailable. This does not establish support in another host's Claude provider. T3's Claude adapter currently records native MCP content without the Codex adapter's MCP App capture/bridge; in that path provide the inbox link rather than claiming an inline widget opened. Do not infer missing inline rendering from a failed card refresh or from missing capability advertisement alone.
Use the initial start_review card if the host created one; do not immediately call review_status to check rendering. A text result or Inbox link does not mean the card was absent.
If the host explicitly reports failed card-to-server calls, or a non-refreshing card has been visually confirmed, use review_status once at the review gate, after aggregation, and at the verification gate to show saved findings and the new phase. Otherwise keep the one live card. Also refresh it on the user's request.
These phase-boundary snapshots override the generic preference to keep one live card when the host cannot refresh it. Do not poll review_status in a loop or claim the original snapshot will update live. Explain that the inline card is a snapshot in this host and the inbox provides the live view.

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
