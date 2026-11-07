/**
 * SARIF 2.1.0 export.
 *
 * This file is the whole integration story. A VS Code or JetBrains SARIF
 * viewer opens it, GitHub code scanning ingests it, and none of that needs a
 * line of code here. Priority, tags and evidence have no SARIF equivalent, so
 * they ride along in `properties` rather than being flattened away.
 */

import type { Finding, Priority } from "../model/types.mts";

const LEVELS: Record<Priority, "error" | "warning" | "note"> = {
  p0: "error",
  p1: "warning",
  p2: "warning",
  p3: "note",
  p4: "note",
};

export const FINGERPRINT_KEY = "pascalReview/v1";

/** Ad-hoc findings still need a stable rule id, so priority stands in. */
function ruleIdOf(finding: Finding): string {
  return finding.rule ?? `review/${finding.priority}`;
}

export function toSarif(target: string, findings: Finding[]): string {
  const ruleIds = [...new Set(findings.map(ruleIdOf))].sort();
  const rules = ruleIds.map((id) => ({
    id,
    shortDescription: {
      text: id.startsWith("review/")
        ? `Review finding of priority ${id.slice("review/".length)}`
        : `Handbook rule ${id}`,
    },
  }));

  const results = findings.map((finding) => {
    const failed =
      finding.verdict === "invalid" || finding.verdict === "tolerated";
    const ruled = finding.history.findLast((entry) => entry.verdict);
    return {
      ruleId: ruleIdOf(finding),
      ruleIndex: ruleIds.indexOf(ruleIdOf(finding)),
      level: LEVELS[finding.priority] ?? "warning",
      message: { text: `${finding.id} ${finding.title}\n\n${finding.body}` },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: finding.anchor.file },
            // A viewer that cannot open the file still shows these, which is
            // the whole point of exporting a report someone else will read.
            region: {
              startLine: finding.anchor.line,
              ...(finding.anchor.endLine
                ? { endLine: finding.anchor.endLine }
                : {}),
              snippet: { text: finding.snippet },
            },
            ...(finding.context
              ? {
                  contextRegion: {
                    startLine: finding.context.start,
                    endLine:
                      finding.context.start + finding.context.lines.length - 1,
                    snippet: { text: finding.context.lines.join("\n") },
                  },
                }
              : {}),
          },
        },
      ],
      // SARIF has the same shape: one location that owns the result, and the
      // other places it is about, each carrying why it is there.
      ...(finding.related && finding.related.length > 0
        ? {
            relatedLocations: finding.related.map((location, index) => ({
              id: index + 1,
              physicalLocation: {
                artifactLocation: { uri: location.file },
                region: {
                  startLine: location.line,
                  ...(location.endLine ? { endLine: location.endLine } : {}),
                  ...(location.context
                    ? {
                        snippet: {
                          text:
                            location.context.lines[
                              location.line - location.context.start
                            ] ?? "",
                        },
                      }
                    : {}),
                },
              },
              ...(location.note ? { message: { text: location.note } } : {}),
            })),
          }
        : {}),
      partialFingerprints: { [FINGERPRINT_KEY]: finding.fingerprint },
      // Three ways a finding stops asking for a viewer's attention, and they
      // are not the same thing: the review was wrong, the finding stands and
      // is carried, or the code was fixed. All suppress, and the
      // justification says which.
      ...(failed || finding.resolution === "resolved"
        ? {
            suppressions: [
              {
                kind: "external",
                status: "accepted",
                justification: failed
                  ? (ruled?.note ?? finding.verdict)
                  : `resolved${finding.links.fixCommit ? ` by ${finding.links.fixCommit.slice(0, 12)}` : ""}`,
                properties: {
                  reason: failed ? finding.verdict : "resolved",
                },
              },
            ],
          }
        : {}),
      properties: {
        findingId: finding.id,
        priority: finding.priority,
        ...(finding.tags ? { tags: finding.tags } : {}),
        evidence: finding.evidence,
        verdict: finding.verdict,
        resolution: finding.resolution,
        ...(finding.confirmedAt ? { confirmedAt: finding.confirmedAt } : {}),
        ...(finding.provenTest ? { provenTest: finding.provenTest } : {}),
        ...(finding.links.fixCommit
          ? { fixCommit: finding.links.fixCommit }
          : {}),
        ...(finding.links.prComment
          ? { prComment: finding.links.prComment }
          : {}),
        ...(finding.links.ruleIssue
          ? { ruleIssue: finding.links.ruleIssue }
          : {}),
        ...(finding.staleAnchor ? { staleAnchor: true } : {}),
        ...(finding.diff ? { diff: finding.diff } : {}),
      },
    };
  });

  const log = {
    $schema:
      "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "pascal-review",
            informationUri: "https://github.com/passsy/pascal_rules",
            rules,
          },
        },
        automationDetails: { id: `pascal-review/${target}` },
        results,
      },
    ],
  };
  return `${JSON.stringify(log, null, 2)}\n`;
}
