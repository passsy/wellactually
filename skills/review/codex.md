# Running the review in Codex

When your tools include one that starts a subagent, such as `spawn_agent`, start each step with it and the prompt the step gives. Use a cheap available model for information gathering and optional splitting; use your own model for reviewers and the verifier. Select the host's configured cheap model or discover an available low-cost model; do not silently run cheap steps on the review model. If no cheap model is available, report that limitation.
Start each with an empty conversation rather than inheriting the user's review session; when `spawn_agent` exposes `fork_turns`, use `"none"`.
Start review queue workers concurrently, then one aggregation-only agent, then ceil(issue groups/10) verification queue workers. No tester agents or static principle groups.
For reviewers, use the restricted Codex runtime below rather than an unrestricted native subagent. Information gathering and aggregation use the host's agent tools. Queue proof workers can use the verification launcher so their concurrency is not limited by the coordinator's native agent slots.

```bash
node "<skill>/scripts/review.mjs" --run-reviewer <dir> --job <job-id> --model <coordinator-model> --effort <coordinator-effort>
node "<skill>/scripts/review.mjs" --run-verifier <dir> --job verification-worker-<n> --model <coordinator-model> --effort <coordinator-effort> --proof-sandbox <host-policy>
```

Prefer --run-reviewers <dir> and --run-verifiers <dir> with the same model/effort and proof-sandbox arguments to launch the whole pool and recover ordinary worker crashes automatically. They preserve failed audits, reuse the dead worker identity, and permit at most two replacements. A known safeguard rejection is not replayed, even if the pool command is repeated. Check incomplete/blocked queue items rather than relying on a successful worker process alone.

Pass the actual host policy explicitly. On an unrestricted/full-access host use --proof-sandbox danger-full-access for proof workers, including normal installed SDK cache writes and localhost test-runner sockets. On a workspace-write host use workspace-write. Never relax a stricter host policy, or reviewer restrictions. Avoid copying an entire SDK just to work around an unnecessarily stricter child sandbox; report the limit when policy prevents the required access.

The runtime removes shell tools, ignores user/project tool configuration and plugins, disables web search and child agents, and applies a read-only sandbox to built-in tools. Its MCP gateway supplies only bounded text reads/search, base-revision reads, assigned principles, immediate candidate creation, and the assigned coverage write. It writes `agents/reviewer-<id>/tool-audit.jsonl` as session evidence. Never replace a failed restricted launch with an unrestricted reviewer. Report unsupported host enforcement as blocked.

When you have no such tool, follow `pi.md` instead.

The commands use `<skill>` for the directory containing this skill's `SKILL.md`; its helper is `scripts/review.mjs`.

Reviewers need restricted read/search tools, read-only Git and MCP queue/candidate tools. Disable project/test/build/probe execution for reviewers using host permissions or tool allowlists. If enforcement is unavailable, report it before dispatch. Verification queue workers get local execution and disposable probe/test permissions; the aggregator only groups candidates.
Preserve host sandbox and approval controls; missing tools must be reported as limitations.
Review workers create candidates; proof workers submit decisions through complete_review_work. Their proof gateway exposes only the claimed issue's candidates and advice. The verification launcher enables shell tools in a workspace-write sandbox for focused proofs, and keeps plugins, web search and child agents disabled. Preserve any stricter host policy; report blocked checks. The coordinator checks authoritative queue completeness and never relays finding records through files.
