# How a finding reads

Write for someone deciding whether to change their code. This standard applies when creating a finding, investigating it, and posting it. The title and description explain the defect; evidence and assessments preserve the investigation.

## Headline first

Use a short title naming the defect or the change needed: `Restore Retry after a deferred download fails`, not a sentence narrating the entire scenario. Leave IDs, priority, rule names and proof labels to their fields.

Open the description with what breaks, including the condition needed to make that statement true. A reader who stops after the first sentence should understand the problem. Then give only the mechanism needed to assess it and the smallest useful remedy. Use exact code names where they clarify the cause; do not walk through every helper and state transition.

Write as a news story, not a lab notebook: consequence first, supporting detail in descending importance. Avoid opening with scope labels such as “Change finding”, “pre-existing defect”, “Proven”, or an account of what you inspected. If an existing defect is newly reachable, explain that relationship briefly where it changes the author's decision.

## Length follows the argument

A typo or an obvious local correction can be one line: `pubish()` → `publish()`. Do not add a paragraph defending an uncontested correction.

An ordinary behavioral finding usually needs a short explanation and a separate remedy paragraph. Do not force headings, a checklist or a minimum length onto it. An architectural disagreement may need more: explain the commitment, concrete maintenance cost, alternative, and what would change your judgment. Include that detail when the author needs it to act or disagree.

Use paragraph breaks, bullets for genuinely parallel cases, and small code examples when they are clearer than prose. Show only the lines that need to change. A dense paragraph listing a call chain, states, test coverage, a proof and a proposed implementation is several arguments competing for attention.

State a defect directly; express a preference as a preference. Ask a question only when an answer could change the conclusion. Missing test coverage establishes a coverage gap, not an observed production failure. An observation can still be useful when the remedy is unknown.

## Keep the investigation in its fields

Keep commands, local proof paths, runtime versions, full output, detailed expected/actual results, rule quotes and investigation limits in evidence or assessments. Locations belong on occurrences. Describe a failing test's decisive observation in one sentence when that helps the reader judge the defect; do not paste the proof report into the description.

During verification, preserve an already clear description unless the checked evidence changes it. Correct the title and claim in place, then reread them as an author would. Adding evidence must not turn the description into an investigation transcript. Preserve user notes, disposition, other evidence and assessments.

An occurrence description explains only what is different about that instance. Omit it when its source location and the shared finding already explain it; do not repeat the full defect above every code block.

## Example

Title: **Restore Retry after a deferred download fails**

If the file is initially unavailable and its later download fails, the row keeps spinning instead of offering Retry again. The timer path leaves the failed document in `_requestedDocuments`; only the immediate download path restores its error state. The failure probe reproduces repeated download attempts without returning to Retry.

Handle timer-driven download failures the same way as immediate failures, then test the unavailable → available → failed path.

The command, captured output, complete call chain and runtime limitations remain attached as evidence. The description should not need another rewrite merely because it is posted to a PR; posting only adapts context that the external reader cannot access.
