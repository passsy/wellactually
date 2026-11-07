# Running the review in Claude Code

Start fresh information-gathering and optional splitter agents with the Agent tool, `subagent_type: general-purpose`, and `model: haiku`.
Start one fresh aggregation-only agent with the session's model after the review gate passes.
Review activity is reported automatically after aggregation; do not send review helpfulness ratings.
Tell all child agents not to call either rating tool.

## Restricted review and proof pools

Use the bundled launcher instead of inventing shell loops or sending reviewers through an unrestricted Agent tool.
Pass the session's exact model and effort.

```bash
node "<skill>/scripts/review.mjs" --run-reviewers <dir> --provider claude --model <session-model> --effort <session-effort>
node "<skill>/scripts/review.mjs" --run-verifiers <dir> --provider claude --model <session-model> --effort <session-effort> --proof-sandbox danger-full-access
```

The reviewer launcher disables built-in tools, hooks, skills, session persistence and user/project setting sources.
Its strict MCP configuration exposes only the assigned review gateway.
Reviewers can read/search, retrieve the claimed principle, create candidates immediately and complete queue work.
They cannot execute code or make generic writes.
Do not replace a failed restricted launch with an unrestricted reviewer.

Proof workers use their generated detached worktrees and a gateway restricted to the claimed issue.
Their built-in Bash/read/search tools are enabled for local proof execution.
Claude proof execution currently requires the coordinator's host to be full-access, explicitly passed as `danger-full-access`.
On a stricter host, report the unsupported enforcement and do not broaden permissions.
Read the project's pinned runtime configuration before installing dependencies or running probes.

The pools run workers concurrently, preserve normalized capability/outcome audits, and replace ordinary dead workers at most twice using the same identity and durable claim.
They never replay an explicit safeguard rejection.
Cancellation stops the pool.
Use the host's background completion notification when needed, then check authoritative MCP coverage with `--check <dir> --stage review` or `verify`.
Do not treat a successful process exit or an agent's self-reported count as completion.

After verification, use saved finding IDs for baseline reconciliation.
Report proof limits, pending or blocked work, replacements and measured stage timings.
