/**
 * Sending a bad finding back to the rules, without sending the client with it.
 *
 * A detector is calibrated by the cases it got wrong, and those cases live on
 * somebody's laptop inside code that is not theirs to publish. The gap
 * between "this rule misfired" and a rule that stops misfiring has been a
 * person remembering to describe it later, from memory, without the code.
 *
 * So this carries the case and not the client. What it assembles is a report
 * about a *rule*: which one, what the review said, what the code looked like,
 * and why the reader disagreed — every piece of it through the redactor, and
 * none of it filed until somebody has read the result.
 *
 * Nothing here posts on its own. `prepare` returns exactly what would be
 * filed; `file` takes that same text back and sends it. Two calls, because
 * the one thing this must never do is publish something by surprise.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readFinding } from "../store/findings.mts";
import { recordedPr } from "../api.mts";
import { languageOf } from "../model/language.mts";
import {
  forbidden,
  redact,
  redactCode,
  type Names,
  type Secrets,
} from "./redact.mts";
import type { TargetPaths } from "../store/paths.mts";
import type { Finding } from "../model/types.mts";

const run = promisify(execFile);

/** Where reports go: Pascal's rules, never the client's repository. */
export const HOME = "passsy/pascal_rules";

/** What is wrong with it, which decides what the rule's author does next. */
export const COMPLAINTS = {
  "false-positive": "the rule does not apply to this code at all",
  "wrong-reasoning":
    "the rule applies, and what the finding says about it is wrong",
  unclear: "the finding may be right and could not be acted on as written",
  feedback: "something else about this rule",
} as const;

export type Complaint = keyof typeof COMPLAINTS;

export interface Report {
  title: string;
  body: string;
  /** What the scrubber took out, for a person to weigh before filing. */
  took: { masked: number; kinds: string[] };
  rule: string | null;
}

/**
 * Everything this review knows that would name its client.
 *
 * Gathered from the review rather than from the finding: the finding is the
 * part that gets published, and the review is the part that knows who it is
 * for. A checkout directory, a target, a branch and a pull request title are
 * between them a fairly complete list of a client's vocabulary.
 */
function secretsOf(paths: TargetPaths): Secrets {
  const pr = recordedPr(paths);
  return {
    from: [
      paths.repo.split("/").pop() ?? "",
      paths.target,
      pr.title ?? "",
      pr.headBranch ?? "",
      pr.baseBranch ?? "",
      pr.author ?? "",
    ].filter((one) => one !== ""),
  };
}

/**
 * As few lines of code as still make the case — and no fewer.
 *
 * A window around the anchor, because this is read by somebody deciding
 * whether a heuristic is too eager, and forty lines of unrelated code is not
 * evidence, it is forty lines of somebody's product.
 *
 * But a window alone is how a report keeps the shape of the code and throws
 * away the reason for it. Take
 *
 *     late final WritableBeacon<…> orders = B.writable(const {});
 *
 * The `late` is required because `B` is inherited, and nothing on that line
 * says so: it is the `extends BeaconController` two hundred lines up, and the
 * import above that. Both are carried, because both are the argument.
 */
const WINDOW = 6;

/** A line that opens something the anchor could be sitting inside. */
const DECLARES =
  /^\s*(?:abstract\s+|final\s+|sealed\s+|base\s+|interface\s+)*(?:class|mixin|extension|enum|struct|object|interface|protocol|def|func|fun|function)\b/;

/** What the anchor's line reaches for that is declared somewhere else. */
function scopeOf(lines: string[], at: number): string[] {
  const opens: string[] = [];
  const indent = (line: string) => /^\s*/.exec(line)?.[0].length ?? 0;
  let floor = indent(lines[at] ?? "");
  for (let i = at - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const here = indent(line);
    if (here >= floor) continue;
    floor = here;
    if (DECLARES.test(line)) opens.unshift(line.replace(/\s*\{\s*$/, " {"));
    if (here === 0) break;
  }
  return opens;
}

/**
 * The imports that say where the borrowed names come from.
 *
 * Only the ones that are somebody's published package. The client's own
 * imports are the client's file tree, which is the thing this must not carry.
 */
function importsIn(source: string, mine: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const line of source.split("\n")) {
    const at = /^\s*(?:import|from|#include|using|require)\b.*$/.exec(line);
    if (!at) continue;
    const pkg = /package:([\w.]+)|from\s+['"]([\w.@/-]+)['"]|<([\w./]+)>/.exec(
      line,
    );
    const name = pkg?.[1] ?? pkg?.[2] ?? pkg?.[3];
    if (!name || mine(name)) continue;
    found.push(line.trim());
  }
  return [...new Set(found)];
}

function snippetOf(finding: Finding): string {
  const context = finding.context;
  if (!context) return finding.snippet;
  const at = finding.anchor.line - context.start;
  const from = Math.max(0, at - WINDOW);
  const to = Math.min(context.lines.length, at + WINDOW + 1);
  const window = context.lines.slice(from, to);
  // What the anchor is inside, when the window does not already show it.
  const opens = scopeOf(context.lines, at).filter(
    (line) => !window.includes(line),
  );
  return opens.length > 0
    ? [...opens, "  // …", ...window].join("\n")
    : window.join("\n");
}

/**
 * The file the finding is anchored in, when it is still there.
 *
 * A review worktree outlives the review it was made for, so usually it is.
 * When it is not, the report loses the imports and the enclosing class and
 * says so by their absence rather than by failing: a snippet with no header
 * is still an argument, just a weaker one.
 */
function sourceOf(paths: TargetPaths, file: string): string {
  const path = join(paths.repo, file);
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** The footer that says this went through a scrubber, and what it caught. */
function scrubbed(kinds: string[]): string {
  const what = kinds.length > 0 ? kinds.join(", ") : "nothing it recognised";
  return [
    "_Filed from a review with `report_finding`. The repository, the branch,",
    "the pull request and the path of the file are never carried. What the",
    `scrubber replaced in what is above: ${what}._`,
  ].join("\n");
}

/**
 * What would be filed, as text, with nothing sent anywhere.
 *
 * The whole report is assembled and then read back by whoever asked for it.
 * That reading is the fourth layer of the redaction, and the only one that is
 * not a heuristic.
 */
export function prepare(
  paths: TargetPaths,
  id: string,
  complaint: Complaint,
  why: string,
): Report {
  const finding = readFinding(paths, id);
  if (!finding) throw new Error(`no finding "${id}" in "${paths.target}"`);

  const secrets = secretsOf(paths);
  // Read to learn which names belong to a library, and to quote the imports
  // that say so. The file itself never travels — only the import lines of
  // packages that are not the client's, which are on a public registry.
  const source = sourceOf(paths, finding.anchor.file);
  const theirs = forbidden(secrets);
  const borrowed = importsIn(source, (name) =>
    theirs.some((word) => name.toLowerCase().includes(word)),
  );
  secrets.library = borrowed.flatMap((line) =>
    line.split(/[^A-Za-z]+/).filter((word) => word.length >= 3),
  );
  // One mapping for the whole report: the same original must wear the same
  // mask in the title, the prose and the code, or the report describes a
  // relationship between things that are not related.
  const names: Names = new Map();
  const rule = finding.rule ?? null;
  const language = languageOf(finding.anchor.file) ?? "text";
  // Scrubbed for names but not for literals: the literal *is* the point of
  // quoting an import, and these lines have already been filtered down to
  // packages that are not the client's — a published package name identifies
  // its author, not the person who depends on it.
  const quoted = redact(borrowed.join("\n"), secrets, names);
  const code = redactCode(snippetOf(finding), secrets, names);
  const title = redact(finding.title, secrets, names);
  const said = redact(finding.body, secrets, names);
  const reason = redact(why, secrets, names);
  const note = finding.note ? redact(finding.note, secrets, names) : null;

  const kinds = new Set([...code.kinds, ...title.kinds, ...said.kinds]);
  if (note) for (const kind of note.kinds) kinds.add(kind);

  const body = [
    `**What is wrong:** ${COMPLAINTS[complaint]}`,
    "",
    rule
      ? `**Rule:** \`${rule}\``
      : "**Rule:** none — the review wrote this one on its own",
    `**Language:** ${language}`,
    "",
    "## What the review said",
    "",
    said.text.trim() || "_(nothing beyond the title)_",
    "",
    "## The code it said it about",
    "",
    "```" + language,
    ...(quoted.text.trim() ? [quoted.text.trimEnd(), ""] : []),
    code.text,
    "```",
    "",
    "## Why that is wrong",
    "",
    reason.text.trim(),
    ...(note
      ? [
          "",
          "## What the reader had already written on it",
          "",
          note.text.trim(),
        ]
      : []),
    "",
    "---",
    "",
    scrubbed([...kinds].sort()),
  ].join("\n");

  return {
    title: rule ? `${rule}: ${title.text}` : `Review finding: ${title.text}`,
    body,
    // The shared map means every pass reports the same running total, so the
    // last word on it is the size of the map rather than a sum.
    took: { masked: names.size, kinds: [...kinds].sort() },
    rule,
  };
}

/**
 * Files it, having been handed back the text that was read.
 *
 * The body is passed in rather than rebuilt here, so that what is filed is
 * what was approved. Rebuilding it would make the thing somebody read and the
 * thing that was sent two objects that merely ought to agree.
 */
export async function file(
  title: string,
  body: string,
  repo = HOME,
): Promise<string> {
  const { stdout } = await run(
    "gh",
    ["issue", "create", "--repo", repo, "--title", title, "--body", body],
    { timeout: 20_000 },
  );
  const url = stdout.trim().split("\n").pop() ?? "";
  if (!url.startsWith("http")) {
    throw new Error(`gh did not answer with an issue URL: ${stdout.trim()}`);
  }
  return url;
}
