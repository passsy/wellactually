# Load principles and filter relevance

Step 3 output is principles.md containing only retained IDs, one per line, without headings or bullets.
Do not write scope.json.
Run --load-principles to run detectors first, then call Well Actually MCP list_principles with repo=plan.root.
Read the entire board's short descriptions and tags only; do not load full advice while filtering.
Check board versions against plan.json and report drift.
Use task.md, optional context.md, detector results, source and diff to settle relevance.
Keep triggered principles and uncertain cases, and consider principles without detectors.
Later workers load full advice with MCP get_principle, passing id and version from plan.json.

Coordinator step 3: run `node "<skill>/scripts/review.mjs" --load-principles <dir>` after preparation.
Run detectors before making relevance decisions.
This updates plan.json without writing full advice bodies or principles.md; the coordinator writes principles.md after filtering.
It also writes detectors-triggered.json (detectors with hits) and detectors-no-findings.json (enabled detectors with zero hits and no failed/unreadable input checks).
Each entry contains id, version, title, tags and hits.
Principles without detectors and disabled/skipped detectors are in neither file.
Failed/unreadable checks remain in plan.json; empty input does not establish a no-findings result.
Read task.md, optional context.md, plan.json, MCP board metadata and both detector files before filtering.
A quiet detector is a relevance signal, not proof its advice cannot apply.
Use tags and short descriptions to decide what source/diff context to inspect.
Write only retained IDs into principles.md.
An empty file is valid if all principles definitively do not apply.
Routing removes excluded IDs from both detector files as well as the advice/index, so child executors cannot discover skipped rules.
Run --route only after this classification.
It removes excluded advice and IDs from worker-facing artifacts and writes route.json/jobs.json.
Follow the detailed relevance rules in SKILL.md.

Operation-specific advice applies only when that operation is in the requested task or changed behavior.
For example, advice explicitly about drafting a commit message is irrelevant to reviewing someone else's existing commits.
Check short descriptions against concrete diff operations before retaining such rules merely because the language matches.
Keep uncertain applicability and triggered principles; do not use quiet detectors as a reason to skip general advice.
