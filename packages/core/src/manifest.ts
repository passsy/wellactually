import { EVENTS, FILE_EVENTS, type EventName } from "@wellactually/sdk";
import type { PackageInfo } from "./packages.ts";

/**
 * What a host needs to know about a principle without running it.
 *
 * Nobody writes this. The build reads it out of the principle: title and
 * summary from `principle.md`, the handlers from what `detector.ts` registers,
 * languages from their globs.
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
  /** Display tags, e.g. ["dart"], derived from the extensions in the globs. They filter nothing. */
  languages: string[];
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
   * The packages from npm whose code is part of the bundle, each at the exact
   * version that was submitted. Absent when the detector uses none.
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

const LANGUAGE_OF_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  kts: "kotlin",
  cs: "csharp",
  sh: "shell",
  md: "markdown",
  yml: "yaml",
};

/** The languages a list of globs selects, read off their file extensions. */
export function languagesOf(globs: string[]): string[] {
  const languages = new Set<string>();
  for (const glob of globs) {
    if (glob.startsWith("!")) {
      continue;
    }
    const extension = /\.(?:\{([a-z0-9,]+)\}|([a-z0-9]+))$/.exec(glob);
    for (const name of (extension?.[1] ?? extension?.[2] ?? "").split(",")) {
      if (name !== "") {
        languages.add(LANGUAGE_OF_EXTENSION[name] ?? name);
      }
    }
  }
  return [...languages];
}
