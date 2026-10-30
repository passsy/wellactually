# Running the review without subagents

pi cannot start subagents, so the review runs in this conversation.
Tell the user that before you start, because the advice and the diff will fill this conversation's context.

Do every step yourself, in the order of the skill, one job at a time:

- Read each worker instruction once before doing that job.
- Write each job's result to its file before you start the next job.
  When the conversation is compacted, the verdicts already written are safe: read `jobs.json` and the files in `verdicts/` to see which jobs are done, and go on with the next.
- Read only what the current job names, then go on to the next job.
