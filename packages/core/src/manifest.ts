import { EVENTS, type EventName } from "@wellactually/sdk";

/**
 * What a host needs to know about a principle without running it.
 *
 * Nobody writes this. The build reads it out of the principle: title and
 * summary from `principle.md`, events and globs from what `detector.ts`
 * exports, languages from the globs.
 */
export interface Manifest {
  /** The `# heading` of principle.md. */
  title: string;
  /** The first paragraph of principle.md. Shown in lists and injected for a `pointer` finding. */
  summary: string;
  /** Display tags, e.g. ["dart"], derived from the extensions in `globs`. They filter nothing. */
  languages: string[];
  /** Which events run the detector. */
  events: EventName[];
  /** Which files run the detector on `write` and `read`. Empty means every file. */
  globs: string[];
  /**
   * The detector API version the bundle was built against. A host hands the
   * detector the event of that version. Absent on principles built before
   * versions were recorded, which are version 1: read it with `apiOf`.
   */
  api?: number;
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
      "principle.md no longer has a header. Remove the block between the --- lines: the id is the folder name, the title is the # heading, the summary is the paragraph below it, and events and globs are exports of detector.ts.",
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

/** Validates what `detector.ts` exports as `events` and `globs`. Missing means: every written file. */
export function readSettings(exported: { events?: unknown; globs?: unknown }): Pick<Manifest, "events" | "globs"> {
  const events = exported.events ?? ["write"];
  if (!Array.isArray(events) || events.length === 0 || events.some((event) => !EVENTS.includes(event as EventName))) {
    throw new ManifestError(`detector.ts must export events as a list of ${EVENTS.join(", ")}, for example: export const events = ["write"];`);
  }
  const globs = exported.globs ?? [];
  if (!Array.isArray(globs) || globs.some((glob) => typeof glob !== "string" || glob === "")) {
    throw new ManifestError('detector.ts must export globs as a list of strings, for example: export const globs = ["**/*.ts"];');
  }
  return { events: [...new Set(events as EventName[])], globs: globs as string[] };
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
    const extension = /\.(?:\{([a-z0-9,]+)\}|([a-z0-9]+))$/.exec(glob);
    for (const name of (extension?.[1] ?? extension?.[2] ?? "").split(",")) {
      if (name !== "") {
        languages.add(LANGUAGE_OF_EXTENSION[name] ?? name);
      }
    }
  }
  return [...languages];
}
