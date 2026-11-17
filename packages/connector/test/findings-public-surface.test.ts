import { expect, test } from "vitest";
import * as findings from "../../findings/index.mts";
import { TOOLS, toolNamed } from "../../findings/tools.mts";

test("the public server and module expose CRUD and queue completion without obsolete workflow operations", () => {
  for (const name of [
    "create_candidates",
    "list_candidates",
    "resolve_candidates",
    "create_observation",
    "list_observations",
    "drop_observation",
    "report_finding",
    "export_dismissals",
  ])
    expect(toolNamed(name)).toBeUndefined();
  for (const name of [
    "createObservation",
    "listObservations",
    "dropObservation",
    "resolveCandidates",
    "applyLegacyQueueDecisions",
    "createCandidates",
  ])
    expect(findings).not.toHaveProperty(name);
  for (const name of [
    "create_finding",
    "update_finding",
    "create_occurrence",
    "update_occurrence",
    "complete_review_work",
  ])
    expect(toolNamed(name)).toBeDefined();
  expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
  expect(
    JSON.stringify(
      TOOLS.map((t) => ({
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    ),
  ).not.toMatch(/Pascal|pascal-findings|Level 0|reviewer or tester/);
});
