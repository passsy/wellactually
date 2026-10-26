# Running the review in Claude Code

Start each step with the Agent tool, `subagent_type` `general-purpose`, and the prompt the step gives.

- The cheap steps, the filter and the change sets, get `model: "haiku"`.
- Every other step gets no `model`, so it runs with the model of this session: the review model.
- Start the subagents of one step in one message, so they run at the same time.
  Claude Code runs at most 20 at once: start more than 20 in batches, the next batch once one has finished.
- Wait for every subagent of a step before you start the next step.

A subagent cannot start subagents of its own, so you start every step yourself.
Each one answers with a line: do not read its output file.
