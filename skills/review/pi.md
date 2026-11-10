# Running the review without subagents

pi cannot start subagents, so the review runs in this conversation.
Tell the user that before you start, because the advice and the diff will fill this conversation's context.

Do every step yourself, in the order of the skill, one job at a time:

- Read each worker instruction once before doing that job.
- Complete each queue item in MCP before claiming the next. After compaction, get_review_session and claim_review_work recover durable progress. There are no local verdict files.
- Read only what the current job names, then go on to the next job.
