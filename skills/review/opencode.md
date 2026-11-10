# Running the review in OpenCode

Start each step with the task tool, the `general` subagent and the prompt the step gives.
Use the host's configured cheap model/agent for information gathering and optional splitting. If the task tool cannot select a cheap model, report that limitation rather than silently claiming a cheap-model run. Reviewers and the verifier use the review model.
Start review queue workers concurrently, then one aggregation-only agent, then ceil(issue groups/10) verification queue workers. No tester agents or static principle groups. Claim and submit coverage in MCP; no local verdict files.

When you have no task tool, follow `pi.md` instead.
