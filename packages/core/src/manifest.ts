import { EVENTS, type EventName } from "@wellactually/sdk";

/** The frontmatter of `principle.md`. */
export interface Manifest {
  /** The slug, unique per advisor: lower case letters, digits and dashes. */
  id: string;
  title: string;
  /** One sentence. Shown in lists and injected for a `pointer` finding. */
  summary: string;
  /** Display tags, e.g. ["dart"]. They do not filter anything; `globs` does. */
  languages: string[];
  /** Which events run the detector. Defaults to ["write"]. */
  events: EventName[];
  /** Which files run the detector on `write` and `read`. Empty means every file. */
  globs: string[];
}

export interface ParsedPrinciple {
  manifest: Manifest;
  /** The markdown below the frontmatter: the advice an agent gets to read. */
  advice: string;
}

export class ManifestError extends Error {}

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/** Splits `principle.md` into its manifest and its advice text, and validates both. */
export function parsePrinciple(source: string): ParsedPrinciple {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) {
    throw new ManifestError("principle.md must start with a frontmatter block between two --- lines");
  }
  const fields = parseFrontmatter(match[1] ?? "");
  const advice = (match[2] ?? "").trim();

  const id = text(fields, "id");
  if (!SLUG.test(id)) {
    throw new ManifestError(`id "${id}" must be 3 to 64 characters of a-z, 0-9 and dashes`);
  }
  const title = text(fields, "title");
  const summary = text(fields, "summary");
  if (summary.length > 200) {
    throw new ManifestError("summary must be one sentence of at most 200 characters");
  }
  if (advice.length < 40) {
    throw new ManifestError("the advice text below the frontmatter is missing or too short to be advice");
  }
  if (advice.length > 20_000) {
    throw new ManifestError("the advice text is longer than 20000 characters; an agent has to read all of it");
  }

  const events = list(fields, "events");
  for (const event of events) {
    if (!EVENTS.includes(event as EventName)) {
      throw new ManifestError(`unknown event "${event}"; known events are ${EVENTS.join(", ")}`);
    }
  }

  return {
    manifest: {
      id,
      title,
      summary,
      languages: list(fields, "languages"),
      events: events.length > 0 ? (events as EventName[]) : ["write"],
      globs: list(fields, "globs"),
    },
    advice,
  };
}

type Fields = Map<string, string | string[]>;

/**
 * The YAML subset a manifest needs: `key: value`, `key: [a, b]`, and a key
 * followed by `- item` lines. Anything else is an error rather than a guess.
 */
function parseFrontmatter(block: string): Fields {
  const fields: Fields = new Map();
  let openList: string[] | null = null;
  for (const raw of block.split(/\r?\n/)) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) {
      continue;
    }
    const item = /^\s+-\s+(.*)$/.exec(raw);
    if (item) {
      if (!openList) {
        throw new ManifestError(`list item without a key: ${raw.trim()}`);
      }
      openList.push(unquote(item[1] ?? ""));
      continue;
    }
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(raw);
    if (!pair) {
      throw new ManifestError(`cannot read frontmatter line: ${raw.trim()}`);
    }
    const key = pair[1] ?? "";
    const value = (pair[2] ?? "").trim();
    openList = null;
    if (value === "") {
      openList = [];
      fields.set(key, openList);
      continue;
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      fields.set(key, inner === "" ? [] : splitInlineList(inner).map(unquote));
      continue;
    }
    fields.set(key, unquote(value));
  }
  return fields;
}

/** Splits on commas that are not inside quotes or braces, so `"**\/*.{ts,tsx}"` stays whole. */
function splitInlineList(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote = "";
  let braces = 0;
  for (const char of inner) {
    if (quote) {
      current += char;
      if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "{") {
      braces++;
    }
    if (char === "}") {
      braces--;
    }
    if (char === "," && braces === 0) {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() !== "") {
    items.push(current.trim());
  }
  return items;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  if (trimmed.length >= 2 && (first === '"' || first === "'") && trimmed.endsWith(first)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function text(fields: Fields, key: string): string {
  const value = fields.get(key);
  if (typeof value !== "string" || value === "") {
    throw new ManifestError(`frontmatter is missing "${key}"`);
  }
  return value;
}

function list(fields: Fields, key: string): string[] {
  const value = fields.get(key);
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  return value;
}
