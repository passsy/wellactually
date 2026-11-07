/** The Well Actually advisory board as the Findings UI/tool surface reads it. */

import { readCached, readLockfile } from "../cli/src/board/board.ts";
import { switchedOff } from "../cli/src/board/switches.ts";

export interface RuleView {
  id: string;
  title: string;
  doc: string;
  description: string | null;
  body: string | null;
}

export interface RuleState {
  id: string;
  title: string;
  doc: string;
  enabled: boolean;
  source: "board" | "project" | "global";
}

export interface RuleSettings {
  repo: string;
  global: string;
  project: string | null;
  rules: RuleState[];
}

function catalogue(repo: string): RuleState[] {
  const off = switchedOff(repo);
  return readLockfile().entries.flatMap((entry) => {
    const cached = readCached(entry.hash);
    if (!cached) return [];
    const scopes = off.get(entry.id) ?? [];
    return [
      {
        id: entry.id,
        title: cached.manifest.title,
        doc: entry.id,
        enabled: entry.enabled && scopes.length === 0,
        source: scopes.includes("project")
          ? ("project" as const)
          : scopes.includes("global")
            ? ("global" as const)
            : ("board" as const),
      },
    ];
  });
}

export function listRules(repo: string, includeDisabled = false): RuleSettings {
  const rules = catalogue(repo);
  return {
    repo,
    global: "Well Actually advisory board",
    project: null,
    rules: includeDisabled ? rules : rules.filter((rule) => rule.enabled),
  };
}

export interface ActiveRule {
  id: string;
  title: string;
  file: string;
  description: string | null;
}

export interface InactiveRule {
  id: string;
  title: string;
  source: RuleState["source"];
  turnedOffBy: string | null;
}

export interface ReviewRules {
  repo: string;
  enabled: ActiveRule[];
  disabled: InactiveRule[];
}

export function reviewRules(repo: string): ReviewRules {
  const rules = catalogue(repo);
  return {
    repo,
    enabled: rules
      .filter((rule) => rule.enabled)
      .map((rule) => ({
        id: rule.id,
        title: rule.title,
        file: rule.doc,
        description: readRule(rule.id)?.description ?? null,
      })),
    disabled: rules
      .filter((rule) => !rule.enabled)
      .map((rule) => ({
        id: rule.id,
        title: rule.title,
        source: rule.source,
        turnedOffBy: null,
      })),
  };
}

export function readRule(id: string): RuleView | null {
  const entry = readLockfile().entries.find((candidate) => candidate.id === id);
  if (!entry) return null;
  const cached = readCached(entry.hash);
  if (!cached) return null;
  return {
    id,
    title: cached.manifest.title,
    doc: id,
    description: cached.manifest.summary,
    body: cached.advice,
  };
}
