# packages

The source of everything that runs on your machine, in three layers: `connector` → `board` → `core`.

- `connector` connects the agent hosts: the hooks Claude, Codex, OpenCode and pi call, the MCP server and the `wellactually` command.
- `board` is the advisory board on this machine: which principles run, their detectors on worker threads, the advice they produce and syncing with the registry, including the review reports it reads from `review-inbox`.
- `core` builds, checks and runs principles: the sandbox a detector runs in, the bundler, the test runner and the licence checks.
  The registry runs the same code, so it holds only what both sides need.
- `detector-sdk` is what a detector imports, and what its tests import to run under vitest.
- `review-inbox` holds what a review produces and where it is triaged: the review sessions and their queues, candidates, findings and verdicts, the Review Inbox, the review card and the server behind them.

[dist](../dist) is built from here.
