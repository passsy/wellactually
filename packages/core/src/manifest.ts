import { EVENTS, FILE_EVENTS, type EventName } from "@wellactually/sdk";
import type { PackageInfo } from "./packages.ts";

/**
 * What a host needs to know about a principle without running it.
 *
 * Nobody writes this. The build reads it out of the principle: title and
 * summary from `principle.md`, the handlers from what `detector.ts` registers,
 * tags from `package.json`.
 */
export interface Handler {
  event: EventName;
  /** Which files the handler runs on, for `write` and `read`. Empty means every file. */
  globs: string[];
}

export interface Manifest {
  /** The `# heading` of principle.md. */
  title: string;
  /** The first paragraph of principle.md. Shown in lists and injected for a `pointer` finding. */
  summary: string;
  /** What the principle is about, e.g. ["dart", "testing"], as its expert wrote them in the `tags` of `package.json`. They filter nothing. */
  tags: string[];
  /** The events the detector has a handler for. A summary of `handlers`, for display. */
  events: EventName[];
  /** Every glob of every handler, once. A summary of `handlers`, for display. */
  globs: string[];
  /**
   * What `detector.ts` registered with `onWrite` and the others, in that order.
   * A host decides from this whether to start the detector for an event.
   */
  handlers: Handler[];
  /**
   * The detector API version the bundle was built against. A host hands the
   * detector the event of that version. Absent on principles built before
   * versions were recorded, which are version 1: read it with `apiOf`.
   */
  api?: number;
  /**
   * The packages whose code is part of the bundle, each at the exact version
   * that was submitted, with its licence. One whose licence does not pass by
   * itself is `approved` in every version the registry took. The full text of
   * each licence is at the end of the bundle. Absent when the detector uses none.
   */
  packages?: PackageInfo[];
}

export interface ParsedPrinciple {
  title: string;
  summary: string;
  /** The whole of principle.md: the advice an agent gets to read. */
  advice: string;
}

export class ManifestError extends Error {}

const PRINCIPLE_ID = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const MAX_SUMMARY_LENGTH = 200;

/** Whether a name can be a principle's id. The id is its folder name, or the name given on the website. */
export function isPrincipleId(name: string): boolean {
  return PRINCIPLE_ID.test(name);
}

export const PRINCIPLE_ID_RULE = "3 to 64 characters of a-z, 0-9 and dashes";

/**
 * Reads the title and the summary out of `principle.md`.
 *
 * The file is plain markdown. Its `# heading` is the title and the paragraph
 * right below it is the summary, so neither is written twice.
 */
export function parsePrinciple(source: string): ParsedPrinciple {
  const advice = source.trim();
  const lines = advice.split(/\r?\n/);
  if (lines[0] === "---") {
    throw new ManifestError(
      "principle.md no longer has a header. Remove the block between the --- lines: the id is the folder name, the title is the # heading, the summary is the paragraph below it, and detector.ts says which events and files it handles.",
    );
  }
  const heading = /^#\s+(.+?)\s*#*$/.exec(lines[0] ?? "");
  if (!heading) {
    throw new ManifestError("principle.md must start with a # heading; it is the principle's title");
  }
  const title = plain(heading[1] ?? "");

  let index = 1;
  while (index < lines.length && (lines[index] ?? "").trim() === "") {
    index++;
  }
  const paragraph: string[] = [];
  while (index < lines.length && (lines[index] ?? "").trim() !== "") {
    paragraph.push((lines[index] ?? "").trim());
    index++;
  }
  if (paragraph.length === 0 || /^(#|```|~~~|[-*+]\s|\d+\.\s|>|\||<)/.test(paragraph[0] ?? "")) {
    throw new ManifestError(
      "principle.md needs one plain sentence right below the heading. It is the summary shown in lists, so say what to do instead, and why.",
    );
  }
  const summary = plain(paragraph.join(" "));
  if (summary.length > MAX_SUMMARY_LENGTH) {
    throw new ManifestError(
      `the paragraph below the heading is the summary and may be at most ${MAX_SUMMARY_LENGTH} characters, this one has ${summary.length}. Keep it to one sentence and start a new paragraph for the rest.`,
    );
  }

  const body = lines.slice(index).join("\n").trim();
  if (body.length < 40) {
    throw new ManifestError("the advice below the summary is missing or too short to be advice");
  }
  if (advice.length > 20_000) {
    throw new ManifestError("the advice text is longer than 20000 characters; an agent has to read all of it");
  }
  return { title, summary, advice };
}

/** Markdown inline marks removed, for places that show text as it is. */
function plain(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .trim();
}

const EXAMPLE = 'onWrite({ globs: ["**/*.ts"], *detect(event) { ... } });';

/** Validates the handlers `detector.ts` registered while it loaded, and sums them up. */
export function readHandlers(registered: unknown): Pick<Manifest, "events" | "globs" | "handlers"> {
  if (!Array.isArray(registered) || registered.length === 0) {
    throw new ManifestError(
      `detector.ts registers no handler, so it would never run. Call onWrite, onRead, onPrompt, onCommand or onOutput at its top level, for example: ${EXAMPLE}`,
    );
  }
  const handlers: Handler[] = [];
  for (const raw of registered as { event?: unknown; globs?: unknown }[]) {
    const event = raw?.event as EventName;
    if (!EVENTS.includes(event)) {
      throw new ManifestError(`detector.ts registers a handler for an event this host does not know: ${String(raw?.event)}`);
    }
    const globs = raw.globs ?? [];
    if (!Array.isArray(globs) || globs.some((glob) => typeof glob !== "string" || glob === "" || glob === "!")) {
      throw new ManifestError(`the globs of a handler are a list of patterns, for example: ${EXAMPLE}`);
    }
    if (globs.length > 0 && !FILE_EVENTS.includes(event)) {
      throw new ManifestError(`only onWrite and onRead take globs, and a handler for ${event} has some`);
    }
    handlers.push({ event, globs: globs as string[] });
  }
  return {
    events: EVENTS.filter((event) => handlers.some((handler) => handler.event === event)),
    globs: [...new Set(handlers.flatMap((handler) => handler.globs))],
    handlers,
  };
}

export const MAX_TAGS = 5;
const MAX_TAG_LENGTH = 30;
const TAGS_EXAMPLE = '"tags": ["dart", "testing"]';

/**
 * Normalizes the tags an expert wrote: trimmed, inner spaces collapsed, each
 * once. Throws a `ManifestError` naming what is wrong for its author.
 */
export function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new ManifestError(`the tags in package.json are a list of up to ${MAX_TAGS} words, for example ${TAGS_EXAMPLE}`);
  }
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new ManifestError(`a tag in package.json is a word in quotes, for example ${TAGS_EXAMPLE}`);
    }
    const tag = item.trim().replace(/\s+/g, " ");
    if (tag === "") {
      continue;
    }
    if (tag.length > MAX_TAG_LENGTH) {
      throw new ManifestError(`a tag may be at most ${MAX_TAG_LENGTH} characters, "${tag}" has ${tag.length}`);
    }
    if (!tags.some((known) => known.toLowerCase() === tag.toLowerCase())) {
      tags.push(tag);
    }
  }
  if (tags.length > MAX_TAGS) {
    throw new ManifestError(`a principle may have at most ${MAX_TAGS} tags, package.json has ${tags.length}`);
  }
  return tags;
}

/** Reads the `tags` of a principle's `package.json`. A principle without them has no tags. */
export function parseTags(packageJson: string | undefined): string[] {
  if (packageJson === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    throw new ManifestError("package.json is not valid JSON");
  }
  const tags = (parsed as { tags?: unknown } | null)?.tags;
  return tags === undefined ? [] : cleanTags(tags);
}

/** `package.json` with `tags` set, or without them when there are none. Null when nothing else is left in it. */
export function withTags(packageJson: string | undefined, tags: string[]): string | null {
  let parsed: Record<string, unknown> = {};
  if (packageJson !== undefined) {
    try {
      const value: unknown = JSON.parse(packageJson);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      // A package.json that is no JSON is the build's to report. The tags start it over.
    }
  }
  const { tags: _old, ...rest } = parsed;
  const next = tags.length === 0 ? rest : { ...rest, tags };
  return Object.keys(next).length === 0 ? null : `${JSON.stringify(next, null, 2)}\n`;
}

/**
 * What a principle's `package.json` may say about the principle itself, apart
 * from its tags. They are not part of a version: a repository sync applies
 * them to the principle, and what they leave out its owner sets on the website.
 */
export interface PrincipleSettings {
  /** Who can see it and run it. */
  visibility?: "public" | "private";
  /** Why it was retired. Retired while it is set, running again once it is gone. */
  retired?: string;
}

const MAX_RETIRED_LENGTH = 500;

/** Reads `visibility` and `retired` from a principle's `package.json`. Throws a `ManifestError` naming what is wrong. */
export function parseSettings(packageJson: string | undefined): PrincipleSettings {
  if (packageJson === undefined) {
    return {};
  }
  let parsed: { visibility?: unknown; retired?: unknown } | null;
  try {
    parsed = JSON.parse(packageJson) as { visibility?: unknown; retired?: unknown } | null;
  } catch {
    throw new ManifestError("package.json is not valid JSON");
  }
  const settings: PrincipleSettings = {};
  if (parsed?.visibility !== undefined) {
    if (parsed.visibility !== "public" && parsed.visibility !== "private") {
      throw new ManifestError('the visibility in package.json is "public" or "private"');
    }
    settings.visibility = parsed.visibility;
  }
  if (parsed?.retired !== undefined) {
    const reason = typeof parsed.retired === "string" ? parsed.retired.trim() : "";
    if (reason === "") {
      throw new ManifestError('retired in package.json is the reason people who ran the principle will read, for example "retired": "Superseded by avoid-late"');
    }
    if (reason.length > MAX_RETIRED_LENGTH) {
      throw new ManifestError(`the reason in retired in package.json may be at most ${MAX_RETIRED_LENGTH} characters, this one has ${reason.length}`);
    }
    settings.retired = reason;
  }
  return settings;
}

/**
 * `package.json` without `visibility` and `retired`, which are not part of a
 * version, in one form whatever its formatting. Two files that differ only in
 * those two give the same text. A file that is no JSON object stays as it is.
 */
export function withoutSettings(packageJson: string | undefined): string | undefined {
  if (packageJson === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(packageJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return packageJson;
    }
    const { visibility: _visibility, retired: _retired, ...rest } = parsed as Record<string, unknown>;
    return JSON.stringify(rest);
  } catch {
    return packageJson;
  }
}

/**
 * The tags of a manifest. Versions built before tags show the languages
 * their globs selected, which is what they showed then.
 */
export function tagsOf(manifest: Partial<Manifest> & { languages?: string[] }): string[] {
  return manifest.tags ?? manifest.languages ?? [];
}
