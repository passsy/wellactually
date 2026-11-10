# Well Actually MCP is the review workspace

Use the installed `wellactually` server (Codex: `mcp__wellactually__*`; Claude: the Well Actually plugin namespace), or the generated local `review` worker gateway. “Findings” describes its local store, not a separate MCP server. Never substitute another findings service or infer an external upload from its name.

Follow the shared **How a finding reads** guidance in your generated instructions (or read `finding-writing.md` beside this file). Apply it to both the title and description; keep investigation detail in evidence and assessments.

A finding exists as soon as it is recorded. There is no candidate kind, promotion or verification status. Later investigation adds source observations, reasoning, executable proofs, counterevidence and assessments to the same record.
Never create findings.json, verified/*.json or another shadow store. Discover create/get/list/update/delete_finding and create/get/list/update/delete_occurrence by capability, without assuming an MCP prefix.

## Initialize

Read plan.json and use its absolute root as repo. Choose one stable target (pr-<number>, branch/range, or local-changes). Call start_review as soon as it is known. Write tracking.json with repo, target, run and availability. A run identifies this invocation and does not require Git.
Missing Well Actually MCP is a blocker; do not fall back to files.

## Record the claim

IDs use a caller-selected `prefix` letter and an ascending number per letter within the review, e.g. `G1`, `G2`, `T1`. Pass `prefix` on creation (default `G` for findings, `O` for occurrences). Use the returned ID everywhere; do not invent display aliases.

Call create_finding with finding:{title,description,rules:[{id}],priority,tags,origins:[{run,source,unit}],evidence:[]} and a stable idempotencyKey derived from run and worker source. The restricted reviewer gateway supplies origins and scope; pass its required idempotencyKey but no repo/target/run/unit.
The description explains the shared defect and remedy. Multiple linked rules can support the claim. Evidence entries have kind source/reasoning/test, polarity supports/contradicts, a description and artifact references. Each entry receives a stable ID. A source-observable rule violation is a finding without needing a test.
Then use create_occurrence with an idempotencyKey scoped to the finding and instance, and occurrence:{findingId,description?,locations:[{file,line,endLine?,note?}]}. One occurrence is an independently addressable instance of the defect; several locations can jointly describe it. Recovered workers reuse the same idempotencyKey or query list_occurrences before adding an occurrence again. Never infer 50 defects merely because one claim has 50 supporting locations.
Use finding IDs in coverage results. Findings are immediately visible in the inbox/card.

## Investigate and edit

Use get_finding and list_occurrences. Read the relevant full pinned advice, production source and base paths. Reviewers inspect source; proof workers can execute focused production-path probes. Record concrete test commands/results and expected/actual behavior as evidence. Attach a proof the reader can understand and reproduce: a runnable test/probe source file, or a Markdown document with the complete test/reproduction, exact run command, prerequisites, expected and actual results, and limitations. Prefer one self-contained proof per distinct claim. If a probe needs production mutations, include the exact changes and how to reproduce them in that Markdown document. Keep raw stdout/stderr logs, grep/baseline dumps and standalone .diff/.patch files in the working directory; do not add them to evidence.artifacts or the completion proofs list. Summarize only the decisive output in the document. A blocked or unexecuted test belongs in the limitations, not as executable proof. A failing probe supports only its demonstrated claim and occurrences. Scope it with occurrenceIds when appropriate. A counterexample is contradicting evidence. An unavailable runtime is a limitation in an assessment, not proof of a defect.
Append an assessment with author, authorType:agent, conclusion and reason. Conclusions are prose, not a server-controlled verification state. Do not invent a confidence score or change a human assessment.
Use update_finding/update_occurrence with patch and expectedRevision from the latest read. Arrays replace their collections: preserve entry IDs and unrelated entries. A conflict requires re-reading and reconciling, never blindly resubmitting the old patch. No linked commit, PR or comment changes lifecycle automatically.

## Consolidate

Consolidate only findings with the same claim and remedy. The result is one finding with n occurrences, never linked parent/child findings. During aggregation, begin_verification merges each multi-ID set into its first finding and transfers its occurrences and supporting information automatically. Keep genuinely different defects separate. Pick a surviving finding or create a consolidated one. Preserve linked rules, origins, evidence and assessments. Move occurrences by updating findingId, clearing or re-scoping occurrence-specific evidence references before moving them. Keep distinct occurrences; consolidate duplicate occurrences deliberately.
Close superseded findings with state:closed and closure:{reason:superseded,explanation,supersededBy:[survivorId]}. Do not call a duplicate disproven. Originals remain readable with their reasons and links.

## Close and track work

When the user asks to fix findings, use the Well Actually `apply-review-fixes` skill. After verified completion, explicitly update the finding to state:closed with closure reason:resolved and read it back before reporting it done. A fix-commit link alone leaves it open; use link-only updates for partial work.

A disproven claim can close with reason disproven and its counterevidence. Rejection records why it should not be acted on. Resolution records why it no longer holds. Superseded records point to the surviving finding. Reopening clears closure with null and sets state:open.
Track any number of commits, PRs and comments in links on the finding or affected occurrences. Fixing 20 of 50 occurrences closes those 20; the parent remains open with the remaining scope. Resolving the last occurrence also resolves an open parent finding. Reopening an occurrence, or adding an open occurrence to a resolved finding, reopens the finding. This preserves its verdict, reporting and work links. A review does not authorize product fixes, external posting or human judgments.
Queue completion is work accounting only. Save all evidence and assessments first; complete_review_work references each finding's id, saved revision, assessmentIds and optional evidenceIds. Finishing an investigation does not change the finding's state.

## Metadata locations

PR titles/bodies and commit messages use locations with kind:metadata, subject:pr-title|pr-body|commit-message, an authoritative HTTP(S) URL in file, full original text, and line/endLine within that text. Do not invent a source-file location. Use distinct subject fragments and include the commit SHA when known.

## User disposition and reporting

`verdict` is a first-class finding field: `undecided` (default), `accepted`, `invalid`, or `tolerated`. It is independent of investigation assessments. `reportedAt` is an optional ISO timestamp recording when the author was told; set it to `null` to clear it. Comment URLs remain in `links[]`. Being reported does not require acceptance or close a finding. A fixed finding has `state: "closed"` and `closure: {reason: "resolved", explanation: "..."}`. A finding can be resolved directly even when some occurrences are open. Fixed telemetry is emitted per resolved finding (credited once to each linked principle), after the five-minute grace; occurrence counts and other findings never gate it.

Use `update_finding` with `expectedRevision` to edit these fields. Arrays still replace their collections; changing verdict or reporting never requires editing assessments. The UI track is derived from these independent fields. Storage supports the current finding/occurrence format only.
