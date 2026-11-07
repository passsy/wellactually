import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  createCandidates,
  listCandidates,
  listFindings,
  resolveCandidates,
  baselineCheck,
  readSource,
} from "../../findings/index.mts";

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-findings-"));
  fs.mkdirSync(path.join(root, "lib"));
  fs.writeFileSync(path.join(root, "lib", "state.ts"), "first();\nsecond();\n");
  return root;
}

const candidate = (source: string, line: number) => ({
  source,
  unit: "all",
  title: `Protect path ${String(line)}`,
  body: `Path ${String(line)} can publish stale work.\n\nReject completion after ownership changes.`,
  evidence: "Reasoned",
  priority: "p2",
  rule: "expert/ownership",
  scope: "introduced",
  anchor: { file: "lib/state.ts", line },
});

describe("Findings MCP review candidates", () => {
  test("retains real metadata locations through verification and baseline reconciliation", () => {
    const root = repo();
    const anchor = { kind: "metadata", subject: "pr-title", file: "https://github.com/example/repo/pull/9#title", line: 1, text: "Wayland: Fix preview placement" };
    const result = createCandidates({ target: "metadata", run: "r", candidates: [{ ...candidate("title", 1), anchor }] }, root);
    expect(result.errors).toEqual([]);
    expect(listCandidates({ target: "metadata" }, root)[0]!.anchor).toMatchObject(anchor);
    expect(resolveCandidates({ target: "metadata", decisions: [{ id: "C1", status: "confirmed" }] }, root).errors).toEqual([]);
    const finding = listFindings({ target: "metadata" }, root)[0]!.findings[0]!;
    expect(finding.anchor).toMatchObject(anchor);
    expect(finding.snippet).toBe(anchor.text);
    expect(finding.authorship).toBeUndefined();
    expect(finding.tags).not.toContain("pre-existing");
    expect(readSource({ target: "metadata", path: anchor.file }, root).lines).toEqual([anchor.text]);
    expect(baselineCheck({ target: "metadata", current: [{ ...anchor, rule: finding.rule }] }, root).seen).toEqual([finding.id]);
    const invalid = createCandidates({ target: "metadata", run: "r", candidates: [{ ...candidate("bad", 1), anchor: { ...anchor, line: 2 } }] }, root);
    expect(invalid.errors[0]!.message).toContain("outside");
  });
  test("stores candidates before verification and resolves them in place", () => {
    const root = repo();
    const created = createCandidates(
      {
        repo: root,
        target: "pr-9",
        run: "run-1",
        candidates: [
          candidate("review:ownership:0", 1),
          candidate("testing:outside:0", 2),
        ],
      },
      root,
    );
    expect(created.errors).toEqual([]);
    expect(
      fs.existsSync(
        path.join(root, ".well-actually", "pr-9", "candidates", "C1.json"),
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(root, ".pascal-review"))).toBe(false);
    expect(created.created).toEqual([
      { id: "C1", source: "review:ownership:0", unit: "all" },
      { id: "C2", source: "testing:outside:0", unit: "all" },
    ]);
    expect(
      listCandidates(
        { repo: root, target: "pr-9", run: "run-1", status: "pending" },
        root,
      ),
    ).toHaveLength(2);

    const result = resolveCandidates(
      {
        repo: root,
        target: "pr-9",
        decisions: [
          { id: "C1", status: "confirmed" },
          {
            id: "C2",
            status: "refuted",
            proof: "The owner cancels the request first.",
          },
        ],
      },
      root,
    );
    expect(result.errors).toEqual([]);
    expect(result.resolved).toEqual([
      { id: "C1", status: "confirmed", findingId: "G1" },
      { id: "C2", status: "refuted" },
    ]);
    expect(
      listCandidates(
        { repo: root, target: "pr-9", run: "run-1", status: "pending" },
        root,
      ),
    ).toEqual([]);
    expect(
      listFindings({ repo: root, target: "pr-9" }, root)[0]!.findings[0],
    ).toMatchObject({
      id: "G1",
      fromCandidate: "C1",
      verification: { status: "confirmed" },
      tags: ["scope:introduced"],
    });
  });

  test("is idempotent by source and returns indexed resolution errors", () => {
    const root = repo();
    const first = createCandidates(
      {
        repo: root,
        target: "local",
        run: "run-1",
        candidates: [candidate("review:0", 1)],
      },
      root,
    );
    const repeated = createCandidates(
      {
        repo: root,
        target: "local",
        run: "run-1",
        candidates: [candidate("review:0", 1)],
      },
      root,
    );
    expect(repeated.created).toEqual(first.created);
    const nextRun = createCandidates(
      {
        repo: root,
        target: "local",
        run: "run-2",
        candidates: [candidate("review:0", 1)],
      },
      root,
    );
    expect(nextRun.created).toEqual([
      { id: "C2", source: "review:0", unit: "all" },
    ]);

    const result = resolveCandidates(
      {
        repo: root,
        target: "local",
        decisions: [{ id: "C1", status: "plausible" }],
      },
      root,
    );
    expect(result.resolved).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        index: 0,
        id: "C1",
        message: expect.stringContaining("needs a reason") as string,
      }),
    ]);
    expect(
      listCandidates(
        { repo: root, target: "local", run: "run-1", status: "pending" },
        root,
      ),
    ).toHaveLength(1);
  });

  test("copies a legacy target before writing to the Well Actually store", () => {
    const root = repo();
    const legacy = path.join(root, ".pascal-review", "local", "candidates");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(
      path.join(legacy, "C1.json"),
      `${JSON.stringify({
        id: "C1",
        run: "old-run",
        source: "review:old:0",
        unit: "all",
        title: "Legacy candidate",
        body: "Legacy problem.\n\nLegacy remedy.",
        evidence: "Reasoned",
        priority: "p3",
        anchor: { file: "lib/state.ts", line: 1 },
        status: "pending",
      })}\n`,
    );

    expect(
      listCandidates(
        { repo: root, target: "local", run: "old-run", status: "pending" },
        root,
      ).map((item) => item.id),
    ).toEqual(["C1"]);
    expect(
      fs.existsSync(
        path.join(root, ".well-actually", "local", "candidates", "C1.json"),
      ),
    ).toBe(true);
  });
});
