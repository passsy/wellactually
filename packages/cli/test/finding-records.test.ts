import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  claimReviewSession,
  claimReviewWork,
  completeReviewWork,
  beginVerification,
  verificationProblems,
  getReviewSession,
} from "../../findings/queues.mts";
import { afterEach, expect, test, vi } from "vitest";
import {
  createFindingRecord,
  mergeFindingRecords,
  getFindingRecord,
  listFindingRecords,
  updateFindingRecord,
  deleteFindingRecord,
  createOccurrence,
  getOccurrence,
  listOccurrences,
  updateOccurrence,
  deleteOccurrence,
} from "../../findings/crud.mts";
import { TOOLS } from "../../findings/tools.mts";
import {
  listFindings,
  readSource,
  setStage,
  setReported,
  listReviews,
} from "../../findings/api.mts";
const roots: string[] = [];
function setup() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wa-records-"));
  roots.push(repo);
  fs.writeFileSync(
    path.join(repo, "classes.ts"),
    Array.from({ length: 50 }, (_, i) => `class C${i} {}`).join("\n"),
  );
  return { repo, target: "review" };
}
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
const finding = (
  at: ReturnType<typeof setup>,
  title = "Classes lack documentation",
) =>
  createFindingRecord(
    {
      ...at,
      finding: {
        title,
        description: "Add documentation to each class.",
        rules: [{ id: "expert/docs" }, { id: "expert/api" }],
      },
    },
    at.repo,
  );

test("resolving the remaining occurrences closes the finding; reopening or adding scope reopens it", () => {
  const at = setup();
  const f = createFindingRecord(
    {
      ...at,
      finding: {
        title: "Repeated defect",
        verdict: "accepted",
        reportedAt: "2026-11-03T10:00:00Z",
        links: [{ kind: "commit", commit: "partial" }],
      },
    },
    at.repo,
  );
  const items = Array.from({ length: 3 }, () =>
    createOccurrence({ ...at, occurrence: { findingId: f.id } }, at.repo),
  );
  const resolve = (o: (typeof items)[number]) =>
    updateOccurrence(
      {
        ...at,
        id: o.id,
        expectedRevision: o.revision,
        actor: "human",
        patch: {
          state: "closed",
          closure: { reason: "resolved", explanation: "Fixed this location" },
        },
      },
      at.repo,
    );
  resolve(items[0]!);
  resolve(items[1]!);
  expect(getFindingRecord({ ...at, id: f.id }, at.repo)).toMatchObject({
    state: "open",
    revision: 1,
  });
  const last = resolve(items[2]!);
  const closed = getFindingRecord({ ...at, id: f.id }, at.repo);
  expect(closed).toMatchObject({
    state: "closed",
    closure: { reason: "resolved" },
    revision: 2,
    verdict: "accepted",
    reportedAt: f.reportedAt,
    links: f.links,
  });
  expect(closed.history.at(-1)).toMatchObject({
    actor: "human",
    revision: 2,
    patch: { state: "closed", closure: { reason: "resolved" } },
  });
  expect(listFindings(at, at.repo)[0]!.findings[0]!.resolution).toBe(
    "resolved",
  );
  const edited = updateOccurrence(
    {
      ...at,
      id: last.id,
      expectedRevision: last.revision,
      patch: { description: "More context" },
    },
    at.repo,
  );
  expect(getFindingRecord({ ...at, id: f.id }, at.repo).revision).toBe(2);
  const reopened = updateOccurrence(
    {
      ...at,
      id: edited.id,
      expectedRevision: edited.revision,
      patch: { state: "open", closure: null },
    },
    at.repo,
  );
  expect(getFindingRecord({ ...at, id: f.id }, at.repo)).toMatchObject({
    state: "open",
    revision: 3,
    verdict: "accepted",
    reportedAt: f.reportedAt,
  });
  expect(
    getFindingRecord({ ...at, id: f.id }, at.repo).closure,
  ).toBeUndefined();
  resolve(reopened);
  expect(getFindingRecord({ ...at, id: f.id }, at.repo).state).toBe("closed");
  createOccurrence({ ...at, occurrence: { findingId: f.id } }, at.repo);
  expect(getFindingRecord({ ...at, id: f.id }, at.repo)).toMatchObject({
    state: "open",
    revision: 5,
    verdict: "accepted",
    reportedAt: f.reportedAt,
  });
});

test("closed occurrences with other reasons do not count as resolved and a rejected finding is preserved", () => {
  const at = setup(),
    f = finding(at);
  createOccurrence(
    {
      ...at,
      occurrence: {
        findingId: f.id,
        state: "closed",
        closure: { reason: "rejected", explanation: "Does not apply here" },
      },
    },
    at.repo,
  );
  createOccurrence(
    {
      ...at,
      occurrence: {
        findingId: f.id,
        state: "closed",
        closure: { reason: "resolved", explanation: "Fixed" },
      },
    },
    at.repo,
  );
  expect(getFindingRecord({ ...at, id: f.id }, at.repo)).toMatchObject({
    state: "open",
    revision: 1,
  });
  const rejected = updateFindingRecord(
    {
      ...at,
      id: f.id,
      expectedRevision: 1,
      patch: {
        state: "closed",
        closure: { reason: "rejected", explanation: "Do not act on this" },
        verdict: "tolerated",
      },
    },
    at.repo,
  );
  const o = createOccurrence(
    { ...at, occurrence: { findingId: f.id } },
    at.repo,
  );
  updateOccurrence(
    {
      ...at,
      id: o.id,
      expectedRevision: 1,
      patch: {
        state: "closed",
        closure: { reason: "resolved", explanation: "Fixed" },
      },
    },
    at.repo,
  );
  expect(getFindingRecord({ ...at, id: f.id }, at.repo)).toEqual(rejected);
});

test("a failed parent write rolls back the occurrence resolution", () => {
  const at = setup(),
    f = finding(at),
    o = createOccurrence({ ...at, occurrence: { findingId: f.id } }, at.repo);
  const rename = fs.renameSync;
  const parentPath = path.join(
    at.repo,
    ".well-actually",
    at.target,
    "findings",
    f.id + ".json",
  );
  const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to) === parentPath) throw new Error("Disk write failed");
    return rename(from, to);
  });
  try {
    expect(() =>
      updateOccurrence(
        {
          ...at,
          id: o.id,
          expectedRevision: 1,
          patch: {
            state: "closed",
            closure: { reason: "resolved", explanation: "Fixed" },
          },
        },
        at.repo,
      ),
    ).toThrow("Disk write failed");
  } finally {
    spy.mockRestore();
  }
  expect(getOccurrence({ ...at, id: o.id }, at.repo)).toEqual(o);
  expect(getFindingRecord({ ...at, id: f.id }, at.repo)).toEqual(f);
});

test("50 separately stored occurrences retain partial progress, multiple commits and PRs", () => {
  const at = setup(),
    f = finding(at);
  const occurrences = Array.from({ length: 50 }, (_, i) =>
    createOccurrence(
      {
        ...at,
        occurrence: {
          findingId: f.id,
          description: `Class C${i}`,
          locations: [{ file: "classes.ts", line: i + 1 }],
        },
      },
      at.repo,
    ),
  );
  for (const occurrence of occurrences.slice(0, 20))
    updateOccurrence(
      {
        ...at,
        id: occurrence.id,
        expectedRevision: occurrence.revision,
        patch: {
          state: "closed",
          closure: { reason: "resolved", explanation: "Documented" },
          links: [
            { kind: "commit", commit: "abc" },
            { kind: "commit", commit: "def" },
            { kind: "pr", url: "https://github.com/a/b/pull/1" },
          ],
        },
      },
      at.repo,
    );
  expect(
    listOccurrences({ ...at, findingId: f.id, state: "open" }, at.repo),
  ).toHaveLength(30);
  expect(getFindingRecord({ ...at, id: f.id }, at.repo)).toMatchObject({
    state: "open",
    rules: [{ id: "expert/docs" }, { id: "expert/api" }],
  });
  expect(
    getOccurrence({ ...at, id: occurrences[0]!.id }, at.repo).links,
  ).toHaveLength(3);
  const directory = path.join(at.repo, ".well-actually", at.target);
  expect(fs.readdirSync(path.join(directory, "occurrences"))).toHaveLength(50);
  expect(fs.readdirSync(path.join(directory, "findings"))).toHaveLength(1);
  expect(
    fs.readFileSync(path.join(directory, "findings", `${f.id}.json`), "utf8"),
  ).not.toMatch(/"(?:kind|verification|anchor|related)":/);
});

test("evidence, assessments and work links do not change state or create a second identity", () => {
  const at = setup(),
    f = finding(at);
  const o = createOccurrence(
    {
      ...at,
      occurrence: {
        findingId: f.id,
        locations: [
          { file: "classes.ts", line: 1 },
          { file: "classes.ts", line: 2 },
        ],
      },
    },
    at.repo,
  );
  const updated = updateFindingRecord(
    {
      ...at,
      id: f.id,
      expectedRevision: 1,
      patch: {
        evidence: [
          {
            kind: "source",
            polarity: "supports",
            description: "Both classes lack doc comments",
            occurrenceIds: [o.id],
          },
          {
            kind: "test",
            polarity: "contradicts",
            description: "Counterexample",
            artifacts: ["probe.txt"],
          },
        ],
        assessments: [
          {
            author: "reviewer",
            authorType: "agent",
            conclusion: "Investigate context",
            reason: "Generated code may be exempt",
          },
        ],
        links: [
          { kind: "commit", commit: "abc" },
          {
            kind: "comment",
            url: "https://github.com/a/b/pull/1#discussion_r2",
          },
        ],
      },
    },
    at.repo,
  );
  expect(updated).toMatchObject({ id: f.id, revision: 2, state: "open" });
  expect(updated.history).toHaveLength(2);
  expect(listFindingRecords(at, at.repo)).toHaveLength(1);
  expect(getOccurrence({ ...at, id: o.id }, at.repo).state).toBe("open");
});

test("revision conflicts prevent lost edits and deletion", () => {
  const at = setup(),
    f = finding(at);
  updateFindingRecord(
    { ...at, id: f.id, expectedRevision: 1, patch: { title: "Corrected" } },
    at.repo,
  );
  expect(() =>
    updateFindingRecord(
      { ...at, id: f.id, expectedRevision: 1, patch: { description: "stale" } },
      at.repo,
    ),
  ).toThrow("Revision conflict");
  expect(() =>
    deleteFindingRecord({ ...at, id: f.id, expectedRevision: 1 }, at.repo),
  ).toThrow("Revision conflict");
  expect(getFindingRecord({ ...at, id: f.id }, at.repo).title).toBe(
    "Corrected",
  );
});

test("deletion protects references and archives records", () => {
  const at = setup(),
    f = finding(at),
    o = createOccurrence({ ...at, occurrence: { findingId: f.id } }, at.repo);
  expect(() =>
    deleteFindingRecord({ ...at, id: f.id, expectedRevision: 1 }, at.repo),
  ).toThrow("occurrences");
  const withEvidence = updateFindingRecord(
    {
      ...at,
      id: f.id,
      expectedRevision: 1,
      patch: {
        evidence: [
          {
            kind: "source",
            polarity: "supports",
            description: "Source observation",
            occurrenceIds: [o.id],
          },
        ],
      },
    },
    at.repo,
  );
  expect(() =>
    deleteOccurrence({ ...at, id: o.id, expectedRevision: 1 }, at.repo),
  ).toThrow("Evidence references");
  const cleared = updateFindingRecord(
    {
      ...at,
      id: f.id,
      expectedRevision: withEvidence.revision,
      patch: { evidence: [] },
    },
    at.repo,
  );
  deleteOccurrence({ ...at, id: o.id, expectedRevision: 1 }, at.repo);
  deleteFindingRecord(
    { ...at, id: f.id, expectedRevision: cleared.revision },
    at.repo,
  );
  expect(listFindingRecords(at, at.repo)).toEqual([]);
  expect(
    fs.readdirSync(path.join(at.repo, ".well-actually", at.target, ".deleted")),
  ).toHaveLength(2);
});

test("consolidation preserves identity and independent occurrences", () => {
  const at = setup(),
    a = finding(at, "First"),
    b = finding(at, "Consolidated");
  const o = createOccurrence(
    { ...at, occurrence: { findingId: a.id } },
    at.repo,
  );
  updateOccurrence(
    { ...at, id: o.id, expectedRevision: 1, patch: { findingId: b.id } },
    at.repo,
  );
  updateFindingRecord(
    {
      ...at,
      id: a.id,
      expectedRevision: 1,
      patch: {
        state: "closed",
        closure: {
          reason: "superseded",
          explanation: "Same issue",
          supersededBy: [b.id],
        },
      },
    },
    at.repo,
  );
  expect(listOccurrences({ ...at, findingId: b.id }, at.repo)[0]!.id).toBe(
    o.id,
  );
  expect(() =>
    deleteFindingRecord({ ...at, id: b.id, expectedRevision: 1 }, at.repo),
  ).toThrow("occurrences");
});

test("CRUD validates fields without imposing a workflow", () => {
  const at = setup(),
    f = finding(at);
  expect(() =>
    updateFindingRecord(
      {
        ...at,
        id: f.id,
        expectedRevision: 1,
        patch: { verification: { status: "confirmed" } },
      },
      at.repo,
    ),
  ).toThrow("not editable");
  expect(() =>
    updateFindingRecord(
      { ...at, id: f.id, expectedRevision: 1, patch: { state: "closed" } },
      at.repo,
    ),
  ).toThrow("closure");
  const closed = updateFindingRecord(
    {
      ...at,
      id: f.id,
      expectedRevision: 1,
      patch: {
        state: "closed",
        closure: { reason: "rejected", explanation: "Generated code" },
      },
    },
    at.repo,
  );
  expect(
    updateFindingRecord(
      {
        ...at,
        id: f.id,
        expectedRevision: closed.revision,
        patch: { state: "open", closure: null },
      },
      at.repo,
    ).state,
  ).toBe("open");
  expect(() =>
    getFindingRecord({ ...at, id: "../../secret" }, at.repo),
  ).toThrow("Invalid record id");
  expect(() =>
    createOccurrence(
      {
        ...at,
        occurrence: {
          findingId: f.id,
          locations: [{ file: "../secret", line: 1 }],
        },
      },
      at.repo,
    ),
  ).toThrow("inside");
});

test("idempotent creation returns the existing finding without overwriting edits", () => {
  const at = setup();
  const create = {
    ...at,
    idempotencyKey: "run/reviewer/1",
    finding: { title: "Original" },
  };
  const f = createFindingRecord(create, at.repo);
  updateFindingRecord(
    { ...at, id: f.id, expectedRevision: 1, patch: { title: "Edited" } },
    at.repo,
  );
  expect(createFindingRecord(create, at.repo)).toMatchObject({
    id: f.id,
    title: "Edited",
    revision: 2,
  });
});

test("user disposition and reporting are first-class fields independent of investigation and closure", () => {
  const at = setup(),
    f = finding(at);
  expect(f.verdict).toBe("undecided");
  const accepted = updateFindingRecord(
    {
      ...at,
      id: f.id,
      expectedRevision: 1,
      patch: {
        verdict: "accepted",
        reportedAt: "2026-11-03T10:00:00Z",
        assessments: [
          {
            author: "human",
            authorType: "human",
            conclusion: "invalid",
            reason: "Assessment is not disposition",
          },
        ],
      },
    },
    at.repo,
  );
  expect(accepted).toMatchObject({
    state: "open",
    verdict: "accepted",
    reportedAt: "2026-11-03T10:00:00Z",
  });
  expect(listFindings(at, at.repo)[0]!.findings[0]).toMatchObject({
    verdict: "accepted",
    reportedAt: accepted.reportedAt,
  });
  const fixed = updateFindingRecord(
    {
      ...at,
      id: f.id,
      expectedRevision: accepted.revision,
      patch: {
        state: "closed",
        closure: { reason: "resolved", explanation: "Fixed" },
      },
    },
    at.repo,
  );
  expect(fixed).toMatchObject({
    verdict: "accepted",
    reportedAt: accepted.reportedAt,
  });
  const cleared = updateFindingRecord(
    {
      ...at,
      id: f.id,
      expectedRevision: fixed.revision,
      patch: { verdict: "undecided", reportedAt: null },
    },
    at.repo,
  );
  expect(cleared).toMatchObject({
    state: "closed",
    closure: { reason: "resolved" },
    verdict: "undecided",
  });
  expect(cleared.reportedAt).toBeUndefined();
  expect(() =>
    updateFindingRecord(
      {
        ...at,
        id: f.id,
        expectedRevision: cleared.revision,
        patch: { reportedAt: "yesterday" },
      },
      at.repo,
    ),
  ).toThrow("ISO timestamp");
  expect(() =>
    updateFindingRecord(
      {
        ...at,
        id: f.id,
        expectedRevision: cleared.revision,
        patch: { verdict: "maybe" },
      },
      at.repo,
    ),
  ).toThrow();
});

test("the UI persists decisions directly and preserves them across unrelated edits", () => {
  const at = setup(),
    f = finding(at);
  setStage({ ...at, id: f.id, to: "accepted", actor: "human" }, at.repo);
  let saved = getFindingRecord({ ...at, id: f.id }, at.repo);
  expect(saved.verdict).toBe("accepted");
  expect(saved.assessments).toEqual([]);
  expect(saved.metadata).not.toHaveProperty("legacy");
  setStage({ ...at, id: f.id, to: "reported", actor: "human" }, at.repo);
  saved = getFindingRecord({ ...at, id: f.id }, at.repo);
  expect(saved.reportedAt).toEqual(expect.any(String));
  setStage({ ...at, id: f.id, to: "fixed", actor: "human" }, at.repo);
  saved = getFindingRecord({ ...at, id: f.id }, at.repo);
  expect(saved).toMatchObject({
    verdict: "accepted",
    state: "closed",
    closure: { reason: "resolved" },
  });
  updateFindingRecord(
    {
      ...at,
      id: f.id,
      expectedRevision: saved.revision,
      patch: { title: "Edited claim" },
    },
    at.repo,
  );
  const presentation = listFindings(at, at.repo)[0]!.findings[0]!;
  expect(presentation).toMatchObject({
    title: "Edited claim",
    verdict: "accepted",
    resolution: "resolved",
    reportedAt: saved.reportedAt,
  });
  expect(presentation.history).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ verdict: "accepted" }),
      expect.objectContaining({ resolution: "resolved" }),
    ]),
  );
  setReported({ ...at, id: f.id, reported: false }, at.repo);
  const disk = JSON.parse(
    fs.readFileSync(
      path.join(
        at.repo,
        ".well-actually",
        at.target,
        "findings",
        f.id + ".json",
      ),
      "utf8",
    ),
  );
  expect(disk).not.toHaveProperty("reportedAt");
  expect(disk.metadata).not.toHaveProperty("legacy");
  expect(disk.assessments).toEqual([]);
});

test("model tool surface exposes CRUD instead of promotion or side-effect shortcuts", () => {
  const names = TOOLS.filter((t) => !t.cardOnly).map((t) => t.name);
  for (const name of [
    "create_finding",
    "update_finding",
    "delete_finding",
    "create_occurrence",
    "update_occurrence",
    "delete_occurrence",
  ])
    expect(names).toContain(name);
  for (const name of [
    "create_candidates",
    "resolve_candidates",
    "link_fix_commit",
    "link_pr_comment",
    "set_resolution",
  ])
    expect(names).not.toContain(name);
});

test("concurrent MCP processes reject a stale patch instead of losing an edit", async () => {
  const at = setup(),
    f = finding(at);
  const code = `import {updateFindingRecord} from ${JSON.stringify(new URL("../../findings/crud.mts", import.meta.url).href)}; const at=JSON.parse(process.argv[1]); try { updateFindingRecord({...at,id:process.argv[2],expectedRevision:1,patch:{title:process.argv[3]}},at.repo); console.log("saved"); } catch(e) { console.log(e.message); }`;
  const results = await Promise.all(
    ["First", "Second"].map((title) =>
      promisify(execFile)(process.execPath, [
        "--input-type=module",
        "-e",
        code,
        JSON.stringify(at),
        f.id,
        title,
      ]),
    ),
  );
  expect(results.filter((r) => r.stdout.trim() === "saved")).toHaveLength(1);
  expect(
    results.filter((r) => r.stdout.includes("Revision conflict")),
  ).toHaveLength(1);
  expect(getFindingRecord({ ...at, id: f.id }, at.repo).revision).toBe(2);
});

test("review investigation enriches the same finding; queue completion does not promote it", () => {
  const at = setup(),
    session = claimReviewSession(
      { ...at, run: "run", sets: [{ id: "all", principles: [] }] },
      at.repo,
    );
  const queue = {
    ...at,
    session: session.id,
    queue: "all",
    worker: "reviewer",
  };
  const claim = claimReviewWork(queue, at.repo) as any;
  const f = createFindingRecord(
    {
      ...at,
      finding: {
        title: "Missing docs",
        origins: [{ run: "run", unit: "all", source: "all/source/0" }],
      },
    },
    at.repo,
  );
  const o = createOccurrence(
    {
      ...at,
      occurrence: {
        findingId: f.id,
        locations: [{ file: "classes.ts", line: 1 }],
      },
    },
    at.repo,
  );
  completeReviewWork(
    {
      ...queue,
      item: claim.work.id,
      claim: claim.work.claim.token,
      result: {
        findings: [f.id],
        investigation: {
          status: "complete",
          reason: "Inspected source",
          questions: [
            {
              question: "Are declarations documented?",
              answer: "C0 is not",
              evidence: ["classes.ts:1"],
            },
          ],
          limits: [],
        },
      },
    },
    at.repo,
  );
  beginVerification(
    {
      ...at,
      session: session.id,
      groups: [{ findings: [f.id], reason: "One issue" }],
    },
    at.repo,
  );
  const proofQueue = {
    ...at,
    session: session.id,
    queue: "verification",
    worker: "investigator",
  };
  const proof = claimReviewWork(proofQueue, at.repo) as any;
  expect(proof.work.findings).toEqual([f.id]);
  expect(proof.work.candidates).toBeUndefined();
  const checked = updateFindingRecord(
    {
      ...at,
      id: f.id,
      expectedRevision: f.revision,
      patch: {
        evidence: [
          {
            id: "source",
            kind: "source",
            polarity: "supports",
            description: "C0 lacks documentation",
            occurrenceIds: [o.id],
          },
        ],
        assessments: [
          {
            id: "assessment",
            author: "investigator",
            authorType: "agent",
            conclusion: "Act on this",
            reason: "The declaration visibly violates the rule",
          },
        ],
      },
    },
    at.repo,
  );
  completeReviewWork(
    {
      ...proofQueue,
      item: proof.work.id,
      claim: proof.work.claim.token,
      result: {
        summary: "Source establishes the violation",
        proofs: ["classes.ts:1"],
        limits: [],
        decisions: [
          {
            id: f.id,
            revision: checked.revision,
            assessmentIds: ["assessment"],
            evidenceIds: ["source"],
          },
        ],
      },
    },
    at.repo,
  );
  const after = getFindingRecord({ ...at, id: f.id }, at.repo);
  expect(after).toMatchObject({
    id: f.id,
    state: "open",
    revision: checked.revision,
  });
  expect(after).not.toHaveProperty("verification");
  expect(listFindingRecords(at, at.repo)).toHaveLength(1);
  expect(
    verificationProblems(
      getReviewSession({ ...at, session: session.id }, at.repo),
      at.repo,
      at.target,
    ),
  ).toEqual([]);
});

test("occurrence retries preserve identity and unchanged locations preserve captured context", () => {
  const at = setup(),
    f = finding(at);
  const request = {
    ...at,
    idempotencyKey: "occurrence/class0",
    occurrence: {
      findingId: f.id,
      locations: [{ file: "classes.ts", line: 1 }],
    },
  };
  const o = createOccurrence(request, at.repo);
  fs.writeFileSync(path.join(at.repo, "classes.ts"), "replacement();\n");
  const changed = updateOccurrence(
    {
      ...at,
      id: o.id,
      expectedRevision: o.revision,
      patch: {
        description: "Updated explanation",
        locations: o.locations,
        evidence: [
          {
            kind: "source",
            polarity: "supports",
            description: "Captured declaration",
          },
        ],
      },
    },
    at.repo,
  );
  expect(changed.locations[0]!.context?.lines[0]).toBe("class C0 {}");
  expect(createOccurrence(request, at.repo)).toMatchObject({
    id: o.id,
    revision: 2,
    description: "Updated explanation",
  });
  expect(listOccurrences({ ...at, findingId: f.id }, at.repo)).toHaveLength(1);
  expect(
    (changed.history.at(-1)!.patch.evidence as { id: string }[])[0]!.id,
  ).toBe(changed.evidence[0]!.id);
});

test("a repository removed during inbox enumeration does not crash the MCP refresh", () => {
  const at = setup();
  finding(at);
  const original = fs.mkdirSync;
  let removed = false;
  const spy = vi.spyOn(fs, "mkdirSync").mockImplementation((...args: any[]) => {
    const dir = String(args[0]);
    if (
      dir.includes(path.basename(at.repo)) &&
      dir.endsWith(path.join(".records", ".lock"))
    ) {
      removed = true;
      fs.rmSync(at.repo, { recursive: true, force: true });
    }
    return Reflect.apply(original, fs, args);
  });
  try {
    expect(() => listReviews()).not.toThrow();
    expect(removed).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

test("caller-selected letters allocate canonical ascending IDs and do not reuse deleted IDs", () => {
  const at = setup();
  const create = (prefix?: string, idempotencyKey?: string) => createFindingRecord({...at,prefix,idempotencyKey,finding:{title:'Claim'}},at.repo);
  expect(create('T','first').id).toBe('T1');
  expect(create('A').id).toBe('A1');
  expect(create('T','first').id).toBe('T1');
  const second = create('T'); expect(second.id).toBe('T2');
  deleteFindingRecord({...at,id:second.id,expectedRevision:second.revision},at.repo);
  expect(create('T').id).toBe('T3');
  expect(create().id).toBe('G1');
  expect(() => create('Bad')).toThrow('one letter');
  expect(createFindingRecord({...at,target:'another',prefix:'T',finding:{title:'Claim'}},at.repo).id).toBe('T1');
  const occurrence = createOccurrence({...at,occurrence:{findingId:'T1',locations:[]}},at.repo);
  expect(occurrence.id).toBe('O1');
  expect(createOccurrence({...at,prefix:'T',occurrence:{findingId:'T1',locations:[]}},at.repo).id).toBe('T4');
});

test("concurrent creators allocate unique ascending IDs per letter", async () => {
  const at = setup();
  const code = `import {createFindingRecord} from ${JSON.stringify(new URL("../../findings/crud.mts", import.meta.url).href)}; const at=JSON.parse(process.argv[1]); console.log(createFindingRecord({...at,prefix:'R',finding:{title:'Concurrent claim'}},at.repo).id);`;
  const results = await Promise.all(Array.from({length:6},()=>promisify(execFile)(process.execPath,['--input-type=module','-e',code,JSON.stringify(at)])));
  expect(results.map(r=>r.stdout.trim()).sort()).toEqual(['R1','R2','R3','R4','R5','R6']);
});


test("merging leaves one visible finding with all occurrences and scoped evidence, and retries are harmless", () => {
  const at=setup();
  const first=createFindingRecord({...at,finding:{title:"Missing docs",description:"Document classes",rules:[{id:"expert/docs",note:"First rule context"}],origins:[{run:"r",unit:"a",source:"one"}]}},at.repo);
  const second=createFindingRecord({...at,finding:{title:"Also missing docs",priority:"p1",rules:[{id:"expert/docs",note:"Second rule context"},{id:"expert/api"}],origins:[{run:"r",unit:"b",source:"two"}]}},at.repo);
  const one=createOccurrence({...at,occurrence:{findingId:first.id,locations:[{file:"classes.ts",line:1}]}},at.repo);
  const two=createOccurrence({...at,occurrence:{findingId:second.id,locations:[{file:"classes.ts",line:2}]}},at.repo);
  updateFindingRecord({...at,id:second.id,expectedRevision:second.revision,patch:{evidence:[{id:"proof",kind:"source",polarity:"supports",description:"Second class is undocumented",occurrenceIds:[two.id]}],assessments:[{id:"assessment",author:"reviewer",authorType:"agent",conclusion:"Supported",reason:"Read class"}],links:[{id:"work",kind:"pr",url:"https://example.com/pr/1"}]}},at.repo);
  const merged=mergeFindingRecords({...at,ids:[first.id,second.id]},at.repo);
  expect(merged).toMatchObject({id:first.id,title:first.title,description:first.description,priority:"p1",state:"open"});
  expect(merged.rules).toEqual([{id:"expert/docs",note:"First rule context\n\nSecond rule context"},{id:"expert/api"}]);
  expect(merged.origins).toHaveLength(2);
  expect(merged.evidence).toMatchObject([{id:"proof",occurrenceIds:[two.id]}]);
  expect(merged.assessments).toHaveLength(1);
  expect(merged.links).toMatchObject([{id:"work",url:"https://example.com/pr/1"}]);
  expect(listOccurrences({...at,findingId:first.id},at.repo).map(o=>o.id).sort()).toEqual([one.id,two.id].sort());
  expect(listOccurrences({...at,findingId:second.id},at.repo)).toEqual([]);
  const original=getFindingRecord({...at,id:second.id},at.repo);
  expect(original).toMatchObject({state:"closed",closure:{reason:"superseded",supersededBy:[first.id]},evidence:[]});
  expect(original.history.some(h=>JSON.stringify(h.patch).includes("Second class is undocumented"))).toBe(true);
  expect(listFindings(at,at.repo).flatMap(review=>review.findings.map(f=>f.id))).toEqual([first.id]);
  expect(mergeFindingRecords({...at,ids:[first.id,second.id]},at.repo)).toEqual(merged);
  // Every resulting rule/occurrence reference remains valid for normal CRUD.
  expect(()=>updateFindingRecord({...at,id:merged.id,expectedRevision:merged.revision,patch:{rules:merged.rules,evidence:merged.evidence}},at.repo)).not.toThrow();
});

test("merging refuses conflicting human notes or verdicts without moving occurrences", () => {
  const at=setup();
  const records=[undefined,"First note","Different note"].map(note=>createFindingRecord({...at,finding:{title:"Same issue",...(note?{note}: {})}},at.repo));
  const occurrence=createOccurrence({...at,occurrence:{findingId:records[1]!.id}},at.repo);
  expect(()=>mergeFindingRecords({...at,ids:records.map(f=>f.id)},at.repo)).toThrow("differing dispositions or notes");
  expect(getOccurrence({...at,id:occurrence.id},at.repo).findingId).toBe(records[1]!.id);
  expect(records.map(f=>getFindingRecord({...at,id:f.id},at.repo))).toEqual(records);
  const accepted=updateFindingRecord({...at,id:records[0]!.id,expectedRevision:records[0]!.revision,patch:{verdict:"accepted"}},at.repo);
  expect(()=>mergeFindingRecords({...at,ids:[accepted.id,records[1]!.id]},at.repo)).toThrow("differing dispositions or notes");
});


test("the file viewer reads only exact evidence artifacts from the selected review, including occurrence evidence", () => {
  const at=setup(), f=finding(at);
  const proofs=fs.mkdtempSync(path.join(os.tmpdir(),"wa-proof-"));roots.push(proofs);
  const artifact=path.join(proofs,"mutation.diff"), unrelated=path.join(proofs,"unrelated.txt"), linked=path.join(proofs,"linked.txt");
  fs.writeFileSync(artifact,"--- a/test.dart\n+++ b/test.dart\n+expect(actual, expected);\n");
  fs.writeFileSync(unrelated,"Unrelated data");fs.symlinkSync(unrelated,linked);
  updateFindingRecord({...at,id:f.id,expectedRevision:f.revision,patch:{evidence:[{kind:"test",polarity:"supports",description:"Mutation proof",artifacts:[artifact,linked]}]}},at.repo);
  const read=readSource({...at,path:artifact,view:"diff"},at.repo);
  expect(read).toMatchObject({path:artifact,kind:"artifact",ref:"review artifact",view:"new"});
  expect(read.base).toBeUndefined();
  expect(read.lines).toContain("+expect(actual, expected);");
  expect(()=>readSource({...at,path:unrelated},at.repo)).toThrow("not a saved artifact");
  expect(()=>readSource({...at,target:"another-review",path:artifact},at.repo)).toThrow("not a saved artifact");
  expect(()=>readSource({...at,path:linked},at.repo)).toThrow("symlink");
  const log=path.join(proofs,"output.txt");fs.writeFileSync(log,"1 failing test");
  createOccurrence({...at,occurrence:{findingId:f.id,evidence:[{kind:"test",polarity:"supports",description:"Occurrence probe",artifacts:[log]}]}},at.repo);
  expect(readSource({...at,path:log},at.repo).lines).toEqual(["1 failing test"]);
  fs.writeFileSync(artifact,Buffer.from([0,1,2]));
  expect(()=>readSource({...at,path:artifact},at.repo)).toThrow("binary artifact");
  fs.truncateSync(artifact,2_000_001);
  expect(()=>readSource({...at,path:artifact},at.repo)).toThrow("too big");
});

test("one unreadable target remains visible and cannot take the inbox or MCP server offline",()=>{
  const bad=setup(),good=setup();const broken=finding(bad);finding(good);
  const file=path.join(bad.repo,".well-actually",bad.target,"findings",broken.id+".json");
  const record=JSON.parse(fs.readFileSync(file,"utf8"));record.schemaVersion=999;fs.writeFileSync(file,JSON.stringify(record));
  const reviews=listReviews();
  expect(reviews.find(r=>r.repo===bad.repo)?.error).toContain("Unsupported finding format");
  expect(reviews.find(r=>r.repo===good.repo)?.error).toBeUndefined();
  expect(()=>getFindingRecord({...bad,id:broken.id},bad.repo)).toThrow("Unsupported finding format");
});
