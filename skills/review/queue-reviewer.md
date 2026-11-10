# Review from the shared set queue

Follow the shared **How a finding reads** guidance in your generated instructions (or read `finding-writing.md` beside this file). Apply it to both the title and description; keep investigation detail in evidence and assessments.

Read the shared task/context, plan and your job's diff parts.
Read related source and callers as needed; your set defines required coverage, not the source-reading boundary.
Crossing has no full diff: read sets.json and trace the contracts joining the sets directly in source.

You cannot execute project code, tests, builds or probes.
Use the restricted review gateway only.
There are no static principle groups or local verdict files.

Call claim_review_work with no arguments.
The gateway supplies session, queue and worker.
A claimed item contains id, kind, optional principle{id,version}, and claim{token,until}.
Keep claiming until the response is complete, waiting or blocked.
Waiting means all remaining work belongs to other workers; blocked means explicit blocked items remain incomplete.
Exit without polling or claiming completion of blocked work.
If an investigation approaches the 15-minute lease, call claim_review_work again to renew your current claim.

For kind source, assess the essential problem, simplest sufficient solution and changed production paths, including state ownership, failure and retirement.
Raise independent concrete defects.
For kind principle, load only the claimed full advice with get_principle, read it completely, derive questions and inspect source/assertions to answer them.
Detector hits in plan.json are hypotheses to confirm or dismiss.
Do not limit review to blockers; keep supported P3/P4 advice.

As soon as an issue is established, call create_finding with finding:{title,description,rules:[{id}],priority,evidence:[{kind:"source",polarity:"supports",description,artifacts:[]}]} and a stable idempotencyKey `<item id>:<index>`. The gateway supplies the run, source and unit.
Record independently addressable instances with create_occurrence and occurrence:{findingId,description?,locations:[{file,line,endLine?,note?}]}. Several ranges can jointly describe one defect. Use a stable occurrence idempotencyKey or query list_occurrences before retrying creation after lease recovery.
Source discoveries have no linked rules. Never claim executable evidence without executing a probe.
Metadata locations use kind metadata, subject pr-title/pr-body/commit-message, authoritative URL in file, full original text and a line within that text.
Snapshot findings describe current scope; change findings explain whether they are introduced, newly exposed, incompletely fixed or pre-existing.

Complete each item immediately with complete_review_work:

```json
{"item":"<id>","claim":"<token>","result":{"verdict":"followed","where":"path:line","findings":[],"investigation":{"status":"complete","reason":"What settles the advice","questions":[{"question":"Specific advice-derived question","answer":"Source-supported answer","evidence":["path:line"]}],"limits":[]}}}
```

Source items omit verdict and where.
Principle verdicts are followed, findings or not_applicable.
findings requires actual MCP finding IDs.
not_applicable pairs only with investigation status not_applicable and requires evidence explaining absence.
Use limited plus nonempty limits for unresolved questions; complete has no unresolved limits.
Not executing tests does not prevent a complete static applicability judgment.
If the server rejects inconsistent coverage, correct it in this conversation and retry the same claim; do not start a repair agent.
Never erase a material limit to pass validation.

After saving an item, claim another.
Do not stop after twenty principles; twenty determines initial worker count, not an assignment limit.
If context grows too large, finish your current item and report that a replacement worker is needed.
Keep all finding descriptions and coverage in MCP.
Reply with done and the number of completed items.

Do not call rate_principle or rate_review_principle.
Aggregation owns suggestion accounting; do not send separate review ratings.
