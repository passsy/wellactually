/**
 * The palette's ranking, where it can be read.
 *
 * Matching is the part of this that can be wrong in a way nobody notices: a
 * palette that returns the right rows in the wrong order still looks like it
 * works, and the reader just presses Enter on something they did not mean.
 */

import { describe, expect, test } from "vitest";
import { flatten, jumpTo, search, type Catalogue } from "./palette.ts";
import { countsOf } from "../shared/domain.ts";
import type { Finding, ReviewSummary } from "../shared/domain.ts";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "G1",
    title: "compute() result is dropped",
    body: "The body.",
    evidence: "Reasoned",
    priority: "p2",
    verdict: "undecided",
    resolution: "unresolved",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    anchor: { file: "lib/service.dart", line: 2 },
    fingerprint: "f".repeat(64),
    history: [],
    links: {},
    ...over,
  } as Finding;
}

function review(over: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    repo: "/tmp/checkout-pr356-3d10d616",
    repoName: "checkout",
    target: "pr-356",
    startedAt: "2026-08-17T09:00:00.000Z",
    lastAt: "2026-08-17T09:00:00.000Z",
    counts: countsOf([finding()], {}),
    ...over,
  };
}

function catalogue(over: Partial<Catalogue> = {}): Catalogue {
  const findings = over.findings ?? [];
  return {
    reviews: [],
    open: null,
    findings,
    counts: countsOf(findings, {}),
    tags: [],
    docs: [],
    rules: [],
    ...over,
  };
}

describe("jumping to anything", () => {
  test("an id is a destination, not a search", () => {
    const hits = flatten(
      search(
        "g12",
        catalogue({
          findings: [
            finding({ id: "G4", title: "G12 is mentioned in this title" }),
            finding({ id: "G12", title: "Something else entirely" }),
          ],
        }),
      ),
    );

    // An id identifies exactly one row on this page, so typing one can only
    // mean that row — even against a title that starts with the same letters.
    expect(hits[0]?.value).toBe("G12");
  });

  test("a fingerprint is a destination, however much of the marker came along", () => {
    const hash = "deadbeef".repeat(8);
    const cat = catalogue({
      findings: [
        finding({ id: "G1" }),
        finding({ id: "G2", fingerprint: hash }),
      ],
    });

    // The hash out of a posted comment's <!-- pascal-review:… --> marker,
    // pasted bare, with the prefix, with the whole marker, or truncated the
    // way a git hash is.
    for (const q of [
      hash,
      `wellactually-review:${hash}`,
      `pascal-review:${hash}`,
      `<!-- wellactually-review:${hash} -->`,
      `<!-- pascal-review:${hash} -->`,
      hash.slice(0, 12),
    ]) {
      expect(flatten(search(q, cat)).map((one) => one.value)).toEqual(["G2"]);
    }
  });

  test("short hex is a word, not a fingerprint", () => {
    const cat = catalogue({
      findings: [finding({ id: "G2", fingerprint: "decade00".repeat(8) })],
    });

    // Below eight characters ordinary words read as hex, and every query
    // would rank fingerprints it never meant.
    expect(flatten(search("decade", cat))).toEqual([]);
  });

  test("a body match needs three characters, and never outranks a title", () => {
    const cat = catalogue({
      findings: [
        finding({ id: "G1", title: "Nothing to see", body: "a race here" }),
        finding({ id: "G2", title: "Race in the note saver", body: "-" }),
      ],
    });

    // Only the finding hits: a pile whose name happens to contain the query
    // ("Tolerated" holds "ra") is allowed to match, it is just not this test.
    const found = (q: string) =>
      flatten(search(q, cat))
        .filter((one) => one.kind === "finding")
        .map((one) => one.value);

    expect(found("race")).toEqual(["G2", "G1"]);
    // At two characters a body search matches most of the review, which is
    // the same as matching nothing.
    expect(found("ra")).toEqual(["G2"]);
  });

  test("each kind is capped, and says how many it is not showing", () => {
    const cat = catalogue({
      findings: Array.from({ length: 9 }, (_, index) =>
        finding({ id: `G${String(index)}`, title: `race ${String(index)}` }),
      ),
    });

    const [group] = search("race", cat);
    // Without a cap one kind fills the list and the palette stops being a way
    // to reach the others, which is the only thing it is for.
    expect(group?.hits).toHaveLength(6);
    expect(group?.more).toBe(3);
  });

  test("an empty query is not an empty palette", () => {
    const open = review();
    const groups = search(
      "",
      catalogue({
        reviews: [open, review({ target: "pr-680" })],
        open: { repo: open.repo, target: open.target },
        findings: [finding()],
      }),
    );

    // The piles of the review in front of you, then somewhere else to be.
    // Which doubles as the discoverability of the piles.
    expect(groups.map((one) => one.kind)).toEqual(["pile", "review"]);
    expect(groups[1]?.hits).toHaveLength(1);
    expect(groups[1]?.hits[0]?.value).toBe("pr-680");
  });

  test("a finding the queue is not showing is still reachable", () => {
    const queue = [finding({ id: "G1" })];

    // The palette searches every finding of the review and the queue is
    // showing one pile of them, so jumping to a hidden one has to clear the
    // filter rather than silently doing nothing.
    expect(jumpTo("G1", queue)).toEqual({ at: 0 });
    expect(jumpTo("G7", queue)).toEqual({ clear: true });
  });
});
