/**
 * Glob matching for the `globs` of a file handler, on forward-slash relative paths.
 *
 * Supports `**`, `*`, `?` and `{a,b}`. A pattern without a slash matches the
 * basename anywhere, so `*.dart` and `**\/*.dart` mean the same thing.
 * A pattern that starts with `!` takes files out again: `!**\/*.g.dart`.
 */

const cache = new Map<string, RegExp>();

export function matchesGlob(path: string, pattern: string): boolean {
  let regex = cache.get(pattern);
  if (!regex) {
    regex = globToRegExp(pattern);
    cache.set(pattern, regex);
  }
  return regex.test(path);
}

/**
 * Whether `globs` select the file at `path`.
 *
 * A file is selected when one of the patterns matches it and no pattern
 * starting with `!` does. Without a pattern that selects, every file is in:
 * an empty list means all files, and `["!**\/*.g.dart"]` all but generated ones.
 */
export function matchesGlobs(path: string, globs: readonly string[]): boolean {
  const excluded = globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
  if (excluded.some((glob) => matchesGlob(path, glob))) {
    return false;
  }
  const included = globs.filter((glob) => !glob.startsWith("!"));
  return included.length === 0 || included.some((glob) => matchesGlob(path, glob));
}

function globToRegExp(pattern: string): RegExp {
  const anchored = pattern.includes("/") ? pattern.replace(/^\.?\//, "") : `**/${pattern}`;
  let source = "";
  let braceDepth = 0;
  for (let i = 0; i < anchored.length; i++) {
    const char = anchored[i] ?? "";
    if (char === "*" && anchored[i + 1] === "*") {
      const slashAfter = anchored[i + 2] === "/";
      source += slashAfter ? "(?:.*/)?" : ".*";
      i += slashAfter ? 2 : 1;
      continue;
    }
    switch (char) {
      case "*":
        source += "[^/]*";
        break;
      case "?":
        source += "[^/]";
        break;
      case "{":
        braceDepth++;
        source += "(?:";
        break;
      case "}":
        if (braceDepth > 0) {
          braceDepth--;
          source += ")";
          break;
        }
        source += "\\}";
        break;
      case ",":
        source += braceDepth > 0 ? "|" : ",";
        break;
      default:
        source += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}
