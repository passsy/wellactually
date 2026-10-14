// packages/sdk/src/glob.ts
var cache = /* @__PURE__ */ new Map();
function matchesGlob(path, pattern) {
  let regex = cache.get(pattern);
  if (!regex) {
    regex = globToRegExp(pattern);
    cache.set(pattern, regex);
  }
  return regex.test(path);
}
function matchesGlobs(path, globs) {
  const excluded = globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
  if (excluded.some((glob) => matchesGlob(path, glob))) {
    return false;
  }
  const included = globs.filter((glob) => !glob.startsWith("!"));
  return included.length === 0 || included.some((glob) => matchesGlob(path, glob));
}
function globToRegExp(pattern) {
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

// packages/sdk/src/index.ts
var EVENTS = ["write", "read", "prompt", "command", "output"];
var WORD_CHAR = /[A-Za-z0-9_$]/;
function findWord(text, word, from = 0) {
  let at = text.indexOf(word, from);
  while (at !== -1) {
    const before = at === 0 ? "" : text[at - 1] ?? "";
    const after = text[at + word.length] ?? "";
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) {
      return at;
    }
    at = text.indexOf(word, at + 1);
  }
  return -1;
}
function mentioned(event, names) {
  for (const name of names) {
    const letters = [...name.toLowerCase().replaceAll(/[_\-.]/g, "")];
    if (letters.length === 0) {
      continue;
    }
    const body = letters.map((letter) => letter === " " ? "\\s+" : letter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[_\\-.]?");
    const match = new RegExp(`(?<![\\p{L}\\p{N}_$.\\-])${body}(?![\\p{L}\\p{N}_$\\-])`, "iu").exec(event.text);
    if (match) {
      return [match[0].includes("\n") ? { depth: "pointer" } : { match: match[0], depth: "pointer" }];
    }
  }
  return [];
}
function lineAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
    }
  }
  return line;
}

// packages/sdk/src/fs.ts
function ask(op, path) {
  const host = globalThis.__fs;
  if (!host) {
    return { error: { code: "ENOENT", message: `ENOENT: no such file or directory, ${op} '${path}'` } };
  }
  return JSON.parse(host(JSON.stringify({ op, path: String(path) })));
}
function existsSync(path) {
  return !("error" in ask("stat", path));
}
function readOnly(name) {
  return () => {
    throw Object.assign(new Error(`EROFS: read-only file system, ${name}. A detector can read the project and cannot change it.`), { code: "EROFS" });
  };
}
var writeFileSync = readOnly("writeFileSync");
var appendFileSync = readOnly("appendFileSync");
var mkdirSync = readOnly("mkdirSync");
var rmSync = readOnly("rmSync");
var unlinkSync = readOnly("unlinkSync");
var renameSync = readOnly("renameSync");
var copyFileSync = readOnly("copyFileSync");

// packages/sdk/src/path.ts
function normalize(path) {
  if (path === "") {
    return ".";
  }
  const absolute = path.startsWith("/");
  const out = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === ".." && out.length > 0 && out.at(-1) !== "..") {
      out.pop();
      continue;
    }
    if (part === ".." && absolute) {
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  if (absolute) {
    return `/${joined}`;
  }
  return joined === "" ? "." : joined;
}
function join(...parts) {
  return normalize(parts.filter((part) => part !== "").join("/"));
}
function dirname(path) {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const slash = trimmed.lastIndexOf("/");
  if (slash === -1) {
    return ".";
  }
  return slash === 0 ? "/" : trimmed.slice(0, slash);
}

// packages/sdk/src/find.ts
function findUp(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
    if (dir === dirname(dir)) {
      return null;
    }
  }
}

// packages/sdk/src/handlers.ts
var registered = [];
var sealed = false;
function register(event, options) {
  const name = `on${event[0]?.toUpperCase() ?? ""}${event.slice(1)}`;
  if (sealed) {
    throw new Error(`${name}() was called while a handler ran. Register handlers at the top level of detector.ts.`);
  }
  const { globs, detect } = typeof options === "object" && options !== null ? options : {};
  if (typeof detect !== "function") {
    throw new Error(`${name}() takes an object with a detect function: ${name}({ *detect(event) { ... } })`);
  }
  registered.push({ event, globs: Array.isArray(globs) ? [...globs] : globs ?? [], handler: detect });
}
function onWrite(options) {
  register("write", options);
}
function onRead(options) {
  register("read", options);
}
function onPrompt(options) {
  register("prompt", options);
}
function onCommand(options) {
  register("command", options);
}
function onOutput(options) {
  register("output", options);
}
export {
  EVENTS,
  findUp,
  findWord,
  lineAt,
  matchesGlob,
  matchesGlobs,
  mentioned,
  onCommand,
  onOutput,
  onPrompt,
  onRead,
  onWrite
};
