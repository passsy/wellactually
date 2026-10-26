# Investigate the solution independently of the principles

Investigate unit `<unit>` in `<dir>` before reading any principle verdicts.
Read `plan.json`, `context.md`, `blind.md`, `map.md` and your unit's full diff.
For `all`, use every diff part; for a set, its jobs in `jobs.json`; for `crossing`, the contracts in `sets.json`.
Read source at the reviewed target, trace relevant unchanged callers and implementations, and keep the reviewed working tree unchanged.
Follow `testing.md` for disposable reproductions and `findings.md` for shared tracking.

## Required evidence

Compare the actual design with `blind.md` against the user's problem and base contracts.
Investigate mismatches that could change behavior, complexity or completeness; mere disagreement with your design is not a defect.

Build an ownership and execution map: state or resource, creator/owner, executor or queue, transfers, cancellation/cleanup/restart, and what can still run afterward.
Trace both sides of each changed boundary and the real production entry point through completion and failure.
For a non-lifecycle change, map its data or contract ownership; when neither applies, include an explicit not-applicable entry with the reason.

Build a changed-behavior and branch-to-test inventory: each new or affected observable behavior, boundary/error branch, existing test location and assertion, and the unprotected failure mode.
Test counts or the presence of a nearby test file do not establish coverage.
For each gap decide whether it warrants a focused probe, a concrete coverage finding, or no finding with a reason.
Include a not-applicable entry with a reason for units without executable behavior.

Derive focused, falsifiable hypotheses from the maps, including cases the happy path and existing suite cannot distinguish.
Record the expected behavior and smallest real-production-path counterexample that would disprove the implementation.
Resolve cheap hypotheses now; hand executable ones to the tester with exact entry points and fixtures.
Do not turn the inventory into a list of speculative findings.

## Output

Write `<dir>/investigation/<unit>.json`:

```json
{
  "unit": "all",
  "designComparison": "Problem, base contracts, design comparison and evidence locations",
  "ownership": ["Resource or data owner, executor, lifetime and source locations, or why inapplicable"],
  "coverage": ["Behavior and branch, existing test/assertion locations, gap and disposition"],
  "hypotheses": ["Failure hypothesis, expected behavior, production entry point and planned or observed counterexample; or an evidence-based reason none remains"]
}
```

Arrays must be nonempty and contain concrete evidence or a justified inapplicable entry.
Write `<dir>/verdicts/investigation-<unit>.json` in the reviewer's format with `job` set to the unit, empty `verdicts` and initial candidates in `outside`.
Principle coverage is not a prerequisite for reporting an independently supported defect.
Use the scope categories and evidence requirements in `reviewer.md`; do not claim a code argument is proven.
Answer only with `done`, the number of initial candidates and any unresolved context.
