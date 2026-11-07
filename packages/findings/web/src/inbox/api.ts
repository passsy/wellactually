/**
 * Every request the page makes, in one place.
 *
 * The failures matter as much as the successes here. This server lives as
 * long as the session that started it, so a page outliving its server is the
 * ordinary case rather than the exotic one, and left uncaught it reads as a
 * spinner that never finishes — which says nothing about what happened or
 * what to do about it.
 */

import type { FindingList, Finding, ReviewSummary } from "../shared/domain.ts";

/**
 * One file the review wrote, as the list route describes it.
 *
 * Declared here rather than imported from the server's own module: that
 * module reaches into node:fs, and pulling it in for one three-field shape
 * would put the whole server API on the browser's side of the build.
 */
export interface DocumentEntry {
  path: string;
  bytes: number;
  changed: string;
}

export class Unreachable extends Error {
  constructor() {
    super(
      "the findings server is not reachable. It runs as long as the session that started it.",
    );
    this.name = "Unreachable";
  }
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new Unreachable();
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      message =
        ((await response.json()) as { error?: string }).error ?? message;
    } catch {
      // An error response that is not JSON still has its status.
    }
    throw new Error(message);
  }
  return response.status === 204 ? (null as T) : ((await response.json()) as T);
}

function send<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export interface Where {
  repo: string;
  target: string;
}

/** Query keys, so an event from the server can invalidate by shape. */
export const keys = {
  reviews: ["reviews"] as const,
  findings: (where: Where) => ["findings", where.repo, where.target] as const,
  docs: (where: Where) => ["docs", where.repo, where.target] as const,
  doc: (where: Where, path: string) =>
    ["doc", where.repo, where.target, path] as const,
  file: (where: Where, path: string, view: string) =>
    ["file", where.repo, where.target, path, view] as const,
  rule: (id: string) => ["rule", id] as const,
};

/** One document the review wrote, as the panel shows it. */
export interface ReviewDocument {
  path: string;
  bytes: number;
  /** Absent when the file is not text. */
  text?: string;
  binary?: boolean;
}

export function readDoc(where: Where, path: string): Promise<ReviewDocument> {
  const query = new URLSearchParams({
    repo: where.repo,
    target: where.target,
    path,
  });
  return api<ReviewDocument>(`/api/doc?${query.toString()}`);
}

/** The raw bytes of one document a review wrote, as an address. */
export function docUrl(where: Where, path: string): string {
  const query = new URLSearchParams({
    repo: where.repo,
    target: where.target,
    path,
  });
  return `/api/doc/raw?${query.toString()}`;
}

export function listReviews(): Promise<ReviewSummary[]> {
  return api<ReviewSummary[]>("/api/reviews");
}

/** What one review's pull request came to when it was last asked about. */
export interface Told {
  repo: string;
  target: string;
  why: string;
  state?: string;
}

/**
 * Ask every forge now rather than waiting for the sweep.
 *
 * The sweep is silent by design — it writes only when something changed — so
 * this is the way to find out that it is working at all, and why it is not.
 */
export function refreshPrs(): Promise<{ checked: Told[] }> {
  return api<{ checked: Told[] }>("/api/pr/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

/** Which server answered, and which install it started from. */
export interface Health {
  version?: string | null;
  platform?: string;
  /**
   * When anything under a watched review directory last moved.
   *
   * The same moment the change event carries, for the tabs that are not
   * holding one open. A tab in the background compares it against the last
   * one it acted on, which is the whole of "did I miss anything".
   */
  changedAt?: string;
}

/**
 * What is serving this page.
 *
 * Sessions outlive plugin updates, so the process on the port is not
 * necessarily the one just installed — which used to make "did my change land
 * or am I looking at last week's build?" a question you answered by chasing
 * pids. The page can just say it.
 */
export function readHealth(): Promise<Health> {
  return api<Health>("/api/health");
}

/**
 * The findings of one review, with the code.
 *
 * With it, unlike the tool of the same name: the page renders that code, it
 * holds the whole target at once so it can mark every finding that touches an
 * open file, and a browser has no context window to spend.
 */
export async function listFindings(where: Where): Promise<FindingList> {
  const query = new URLSearchParams({ repo: where.repo, target: where.target });
  const lists = await api<FindingList[]>(`/api/findings?${query.toString()}`);
  return (
    lists[0] ?? { target: where.target, findings: [], seen: {}, follow: {} }
  );
}

/** One axis of one finding. Each is a separate answer with a different
 * person behind it, which is why they are separate routes. */
export function setStage(
  where: Where,
  id: string,
  to: string,
): Promise<Finding> {
  return send<Finding>(`/api/findings/${encodeURIComponent(id)}/stage`, {
    ...where,
    to,
    actor: "human",
  });
}

export function setNote(
  where: Where,
  id: string,
  note: string,
): Promise<Finding> {
  return send<Finding>(`/api/findings/${encodeURIComponent(id)}/note`, {
    ...where,
    note,
  });
}

/**
 * The reader's flag on a finding, and the way it comes off again.
 *
 * Only the page sends these, like the read receipts beside them: nothing an
 * agent does should decide what a person is not finished thinking about.
 */
export function markFollow(
  where: Where,
  ids: string[],
  follow: boolean,
): Promise<unknown> {
  return api("/api/follow", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...where, ids, follow }),
  });
}

/** Read receipts. Only the page sends them, so there is no tool of this name. */
export function markSeen(
  where: Where,
  ids: string[],
  read = true,
): Promise<unknown> {
  return api("/api/seen", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...where, ids, read }),
  });
}

/**
 * The documents the review wrote by hand.
 *
 * The generated views are deliberately not in here: being generated is the
 * right reason to keep them out of a list of what a review wrote.
 */
export function listDocs(where: Where): Promise<DocumentEntry[]> {
  return api<DocumentEntry[]>(
    `/api/docs?repo=${encodeURIComponent(where.repo)}&target=${encodeURIComponent(where.target)}`,
  );
}

export type SourceView = "diff" | "old" | "new";

export interface SourceFile {
  path: string;
  /** The commit the content came from, or "working tree". */
  ref: string;
  lines: string[];
  view?: SourceView;
  /** Absent when the review has no base, so there is only one version. */
  base?: string;
}

export interface RuleView {
  id: string;
  title: string;
  doc: string;
  description: string | null;
  body: string;
}

export function readSource(
  where: Where,
  path: string,
  view: SourceView,
): Promise<SourceFile> {
  const query = new URLSearchParams({
    repo: where.repo,
    target: where.target,
    path,
    view,
  });
  return api<SourceFile>(`/api/file?${query.toString()}`);
}

export function readRule(id: string): Promise<RuleView> {
  return api<RuleView>(`/api/rule?id=${encodeURIComponent(id)}`);
}

/** One rule of the handbook, as the catalogue route describes it. */
export interface RuleEntry {
  id: string;
  title: string;
  doc: string;
  enabled?: boolean;
}

/**
 * Every rule there is, fetched once.
 *
 * Kept as the promise rather than the answer, so that ten references in one
 * body ask for the catalogue once between them instead of ten times.
 *
 * The route answers with where the rules came from as well as what they are,
 * because it is also what the handbook page is drawn from. Only the rules are
 * wanted here, and unwrapping them at the edge means nothing downstream has
 * to know the route has a shape at all.
 */
let catalogue: Promise<RuleEntry[]> | null = null;

export function listRules(): Promise<RuleEntry[]> {
  catalogue ??= api<{ rules?: RuleEntry[] }>("/api/rules").then(
    (answer) => answer.rules ?? [],
  );
  return catalogue;
}
