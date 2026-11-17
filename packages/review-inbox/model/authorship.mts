/**
 * Works out whose work an anchored span is: `git blame`, asked three times.
 *
 * The diff cannot answer this. A renamed file whose edits push it under git's
 * similarity threshold arrives as a whole-file add, and a per-file diff
 * (`git diff base -- newpath`) degrades every rename that way, because the
 * deleted old path is outside the pathspec and there is nothing left to pair
 * the add with. A wrapped block is worse: every re-indented line genuinely
 * differs from the base, so no diff flag short of `-w` even sees the problem.
 *
 * Blame over `mergebase..HEAD` answers it line by line. A line the branch did
 * not write reaches the boundary commit and is marked so, and the flags decide
 * what "write" means: nothing for the letter of the text, `-w` to forgive
 * indentation, `-M -C -C` to follow code moved within and between files.
 * Asked in that order, the first run that says "the author wrote none of
 * this" names the most honest of the four answers.
 *
 * Every git failure is an absent answer, not an error. A review on a shallow
 * clone, an uncommitted file, or a base that is not fetched should still be
 * able to write its finding — it just cannot say whose lines it sits on.
 */

import { execFileSync } from "node:child_process";
import type { Authorship } from "./types.mts";
import type { Span } from "./context.mts";

export function classifyAuthorship(
  repo: string,
  base: string,
  file: string,
  span: Span,
): Authorship | undefined {
  // The same base the diff uses, reduced to its left end: "origin/main...HEAD"
  // measures from the merge base, and blame has no three-dot form of its own.
  const cut = base.indexOf("..");
  const ref = cut === -1 ? base : base.slice(0, cut);
  const mergeBase = git(repo, ["merge-base", ref, "HEAD"])?.trim();
  if (!mergeBase) return undefined;

  const authored = (flags: string[], wholeFile = false) =>
    authoredAny(repo, `${mergeBase}..HEAD`, file, span, flags, wholeFile);

  const literally = authored([]);
  if (literally === undefined) return undefined;
  if (!literally) return "untouched";
  const beyondWhitespace = authored(["-w"]);
  if (beyondWhitespace === undefined) return undefined;
  if (!beyondWhitespace) return "whitespace-only";
  // Move detection needs the whole file: `-L` hands the similarity check only
  // the span's own lines, and a span shorter than the threshold can never be
  // recognised as a copy of anything.
  const beyondMoves = authored(["-w", "-M", "-C", "-C"], true);
  if (beyondMoves === undefined) return undefined;
  if (!beyondMoves) return "moved";
  return "changed";
}

/**
 * Whether any line of the span was written on the branch, under these flags.
 *
 * `--line-porcelain` repeats the full header for every line, so each line's
 * boundary mark can be read off without tracking which commit it came from.
 * A code line reading `boundary` cannot be mistaken for the attribute:
 * content lines arrive tab-prefixed.
 */
function authoredAny(
  repo: string,
  range: string,
  file: string,
  span: Span,
  flags: string[],
  wholeFile: boolean,
): boolean | undefined {
  const end = Math.max(span.line, span.endLine ?? span.line);
  const out = git(repo, [
    "blame",
    "--line-porcelain",
    ...(wholeFile ? [] : ["-L", `${span.line},${end}`]),
    ...flags,
    range,
    "--",
    file,
  ]);
  if (out === undefined) return undefined;
  let lines = 0;
  let boundary = 0;
  let counted = false;
  for (const each of out.split("\n")) {
    const header = /^[0-9a-f]{40} \d+ (\d+)/.exec(each);
    if (header) {
      const at = Number(header[1]);
      counted = at >= span.line && at <= end;
      if (counted) lines += 1;
    } else if (counted && each === "boundary") {
      boundary += 1;
    }
  }
  if (lines === 0) return undefined;
  return lines > boundary;
}

function git(repo: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}
