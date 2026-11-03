/**
 * Taking a client's product out of a finding, so the rule can be argued about.
 *
 * A false positive is only worth reporting with the code that caused it, and
 * that code belongs to somebody who is not the person filing the report. It
 * is under review because it is unreleased, and it is under review for a
 * client whose product is not public. So the whole of this feature is the
 * part that decides what does not travel.
 *
 * Four layers, because no single one of them is trustworthy:
 *
 *   1. What is never carried at all. The repository, the checkout, the pull
 *      request, the branch, the author, the path of the file. None of it
 *      helps calibrate a detector, and every one of them names a client.
 *   2. Words taken from those same facts. A checkout called
 *      "acme-scanner-pr681" makes "acme" and "scanner" forbidden, and any
 *      identifier built from them is replaced wherever it appears.
 *   3. Shapes that carry meaning regardless of spelling: URLs, addresses,
 *      absolute paths, long digits, and prose long enough to be product copy.
 *   4. A person reading it. The three above are heuristics and this one is
 *      not, which is why nothing is ever filed without being shown first.
 *
 * A masked identifier keeps its shape — a class stays PascalCase, a field
 * stays camelCase — and the same original always becomes the same mask, so
 * the code still reads as code and the argument about the detector survives.
 */

/** What a redaction pass was given to hide, and what it must not. */
export interface Secrets {
  /** The checkout directory name, the target, the branch, the pull request
   * title: anything naming what is being reviewed. */
  from: string[];
  /**
   * Words that belong to a library rather than to the client, taken from the
   * package imports of the file the finding is in.
   *
   * Without this the scrubber removes the answer along with the client. A
   * `late final` is often required precisely because its initialiser reaches
   * for something inherited — `B.writable(...)`, where `B` comes from a
   * `BeaconController` the class extends — and a report that masks the
   * library's own names has kept the shape of the code and deleted the reason
   * for it. `state_beacon` is on pub.dev; it identifies nobody.
   */
  library?: string[];
}

/**
 * Words too ordinary to be anybody's product.
 *
 * A checkout called "noa-file-service" would otherwise make "file" and
 * "service" forbidden and mask half the code, which reads as gibberish and
 * hides nothing: the giveaway in that name is "noa".
 */
const ORDINARY = new Set([
  "the",
  "and",
  "for",
  "app",
  "api",
  "web",
  "www",
  "src",
  "lib",
  "core",
  "main",
  "test",
  "tests",
  "demo",
  "dev",
  "prod",
  "staging",
  "release",
  "file",
  "files",
  "service",
  "services",
  "server",
  "client",
  "data",
  "model",
  "models",
  "view",
  "views",
  "page",
  "pages",
  "util",
  "utils",
  "common",
  "shared",
  "base",
  "new",
  "old",
  "mobile",
  "android",
  "ios",
  "flutter",
  "dart",
  "kotlin",
  "swift",
  "python",
  "backend",
  "frontend",
  "feature",
  "features",
  "project",
  "repo",
  "code",
  "scan",
  "upload",
  "download",
  "flow",
  "form",
  "user",
  "users",
  "admin",
  "auth",
  "login",
  "sync",
  "store",
  "state",
  "widget",
  "screen",
  "module",
  "package",
]);

/** The pull request suffix a review worktree carries, e.g. "-pr681". */
const CHECKOUT_SUFFIX = /-pr-?\d+$/i;

/**
 * The words that must not survive, taken from what is being reviewed.
 *
 * Split on anything that is not a letter, so "NoaFileService", "noa_file" and
 * "noa-file" all give up the same pieces.
 */
export function forbidden(secrets: Secrets): string[] {
  const words = new Set<string>();
  // A word the file's own imports show to be a library's is not a client's.
  const library = new Set(
    (secrets.library ?? []).map((one) => one.toLowerCase()),
  );
  for (const source of secrets.from) {
    const cleaned = source.replace(CHECKOUT_SUFFIX, "");
    for (const piece of cleaned.split(/[^A-Za-z]+/)) {
      const word = piece.toLowerCase();
      // Two letters is an initialism or a typo, and masking on two letters
      // masks most of any codebase.
      if (word.length < 3) continue;
      if (ORDINARY.has(word) || library.has(word)) continue;
      words.add(word);
    }
    // Camel case hides the pieces from the split above: "NoaScanner" is one
    // piece there and two words here.
    for (const piece of cleaned.split(/(?=[A-Z])|[^A-Za-z]+/)) {
      const word = piece.toLowerCase();
      if (word.length < 3 || ORDINARY.has(word) || library.has(word)) continue;
      words.add(word);
    }
  }
  // "AcmeScanner" gives up "acme", "scanner" and the whole of "acmescanner",
  // and the last of those can never match anything the first does not. A
  // shorter list is the same list, and it is one a person can check.
  const all = [...words].sort();
  return all.filter(
    (word) => !all.some((other) => other !== word && word.includes(other)),
  );
}

/**
 * The masks handed out so far, shared by every pass of one report.
 *
 * A report is several passes — the title, the body, the code, the reader's
 * note — and each of them would otherwise start counting at one, so
 * `Redacted1` in the prose and `Redacted1` in the code would be two different
 * things wearing the same name. That is worse than not masking: it invents an
 * identity rather than hiding one.
 */
export type Names = Map<string, string>;

/** What one pass took out, for the person who has to approve it. */
export interface Redaction {
  text: string;
  /** How many distinct identifiers were replaced. */
  masked: number;
  /** What kinds of thing were taken out, for the preview to list. */
  kinds: string[];
}

const URL_LIKE = /\b(?:https?:\/\/|www\.)[^\s"'`)\]]+/gi;
const EMAIL_LIKE = /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g;
const ABSOLUTE_PATH = /(?:\/Users\/|\/home\/|[A-Z]:\\)[^\s"'`)\]]+/g;
const LONG_DIGITS = /\b\d{6,}\b/g;

/**
 * A word that may be part of an identifier, with the identifier around it.
 *
 * Matched whole so that masking replaces the identifier rather than leaving
 * "NoaScanner" as "RedactedScanner" — a half-masked name is a name.
 */
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;

type Shape = "pascal" | "screaming" | "snake" | "camel";

/**
 * What a masked name is called instead.
 *
 * The names every programmer already reads as "this one does not matter" —
 * so a snippet comes out looking like an example somebody wrote to make a
 * point, which is exactly what it now is. `Redacted3` read as a legal
 * document; `late final Baz _qux = Baz();` reads as Dart.
 *
 * Past the end of the list they carry a number, because a report with
 * fourteen distinct masked names has bigger problems than its vocabulary.
 */
const PLACEHOLDERS = [
  "foo",
  "bar",
  "baz",
  "qux",
  "quux",
  "corge",
  "grault",
  "garply",
  "waldo",
  "fred",
  "plugh",
  "xyzzy",
  "thud",
];

function placeholder(n: number): string {
  const word = PLACEHOLDERS[n % PLACEHOLDERS.length] ?? "foo";
  const round = Math.floor(n / PLACEHOLDERS.length);
  return round === 0 ? word : `${word}${String(round + 1)}`;
}

/**
 * A leading underscore is privacy, not spelling.
 *
 * In Dart it is the whole of what makes a member private, so a mask that
 * drops it changes what the code says — and a mask that reads it as snake
 * case turns `_acmeScanner` into `redacted_3`, which is a third thing the
 * original was not.
 */
function shapeOf(name: string): { shape: Shape; lead: string } {
  const lead = /^_+/.exec(name)?.[0] ?? "";
  const bare = name.slice(lead.length);
  if (/^[A-Z0-9_$]+$/.test(bare) && bare.includes("_"))
    return { shape: "screaming", lead };
  if (/^[A-Z]/.test(bare)) return { shape: "pascal", lead };
  if (bare.includes("_")) return { shape: "snake", lead };
  return { shape: "camel", lead };
}

function maskName(name: string, n: number): string {
  const { shape, lead } = shapeOf(name);
  const word = placeholder(n);
  if (shape === "pascal") return lead + word[0]!.toUpperCase() + word.slice(1);
  if (shape === "screaming") return lead + word.toUpperCase();
  return lead + word;
}

/**
 * Everything a report carries, with the client taken out of it.
 *
 * Runs over code and over prose alike: a finding's own title is written by a
 * review that has been reading the product all day, and is quite capable of
 * naming it.
 */
export function redact(
  text: string,
  secrets: Secrets,
  seen: Names = new Map(),
): Redaction {
  const words = forbidden(secrets);
  const kinds = new Set<string>();

  let out = text;

  out = out.replace(URL_LIKE, () => {
    kinds.add("links");
    return "<link>";
  });
  out = out.replace(EMAIL_LIKE, () => {
    kinds.add("addresses");
    return "<address>";
  });
  out = out.replace(ABSOLUTE_PATH, () => {
    kinds.add("paths");
    return "<path>";
  });
  out = out.replace(LONG_DIGITS, () => {
    kinds.add("long numbers");
    return "<number>";
  });

  if (words.length > 0) {
    out = out.replace(IDENTIFIER, (name) => {
      const lower = name.toLowerCase();
      if (!words.some((word) => lower.includes(word))) return name;
      const already = seen.get(name);
      if (already !== undefined) return already;
      const mask = maskName(name, seen.size);
      seen.set(name, mask);
      kinds.add("names");
      return mask;
    });
  }

  return { text: out, masked: seen.size, kinds: [...kinds].sort() };
}

/**
 * The same, for a whole block of code, with one extra rule.
 *
 * A string literal is where product copy lives — an error message naming the
 * app, a URL, a customer-facing sentence — and none of it argues about a
 * detector. Anything long enough to be a sentence goes; short ones stay,
 * because `"GET"` and `"application/json"` are part of what the code means.
 */
export function redactCode(
  code: string,
  secrets: Secrets,
  seen: Names = new Map(),
): Redaction {
  const pass = redact(code, secrets, seen);
  let dropped = false;
  const text = pass.text.replace(
    /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g,
    (whole, quote: string, body: string) => {
      if (body.length <= 24 && !/\s\S+\s/.test(body)) return whole;
      dropped = true;
      return `${quote}…${quote}`;
    },
  );
  const kinds = dropped ? [...pass.kinds, "long strings"].sort() : pass.kinds;
  return { ...pass, text, kinds };
}
