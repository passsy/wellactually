/**
 * Glob matching for a principle's `globs`, on forward-slash relative paths.
 *
 * Supports `**`, `*`, `?` and `{a,b}`. A pattern without a slash matches the
 * basename anywhere, so `*.dart` and `**\/*.dart` mean the same thing.
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

/** True when `globs` is empty, or when any of them matches. */
export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  if (globs.length === 0) {
    return true;
  }
  return globs.some((glob) => matchesGlob(path, glob));
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
