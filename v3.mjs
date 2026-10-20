// packages/sdk/src/glob.ts
var cache = /* @__PURE__ */ new Map();
function matchesGlob(path, pattern) {
  let matcher = cache.get(pattern);
  if (!matcher) {
    matcher = compile(pattern);
    cache.set(pattern, matcher);
  }
  return matcher(path);
}
function matchesGlobs(path, globs) {
  const excluded = globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
  if (excluded.some((glob) => matchesGlob(path, glob))) {
    return false;
  }
  const included = globs.filter((glob) => !glob.startsWith("!"));
  return included.length === 0 || included.some((glob) => matchesGlob(path, glob));
}
function parse(pattern) {
  const anchored = [...pattern.includes("/") ? pattern.replace(/^\.?\//, "") : `**/${pattern}`];
  const root = [];
  const open = [];
  const current = () => open.at(-1)?.at(-1) ?? root;
  for (let i = 0; i < anchored.length; i++) {
    const char = anchored[i] ?? "";
    if (char === "*" && anchored[i + 1] === "*") {
      const slashAfter = anchored[i + 2] === "/";
      current().push({ kind: slashAfter ? "folders" : "any" });
      i += slashAfter ? 2 : 1;
      continue;
    }
    if (char === "*") {
      current().push({ kind: "star" });
    } else if (char === "?") {
      current().push({ kind: "one" });
    } else if (char === "{") {
      open.push([[]]);
    } else if (char === "}" && open.length > 0) {
      const options = open.pop();
      current().push({ kind: "either", options });
    } else if (char === "," && open.length > 0) {
      open.at(-1)?.push([]);
    } else {
      current().push({ kind: "char", char });
    }
  }
  while (open.length > 0) {
    const [first = [], ...rest] = open.pop();
    current().push({ kind: "char", char: "{" }, ...first, ...rest.flatMap((option) => [{ kind: "char", char: "," }, ...option]));
  }
  return root;
}
var anyChar = () => true;
var notSlash = (char) => char !== "/";
function compile(pattern) {
  const states = [{ moves: [], free: [] }];
  const add = () => states.push({ moves: [], free: [] }) - 1;
  const state = (index) => states[index];
  const sequence = (pieces, next) => {
    let after = next;
    for (let i = pieces.length - 1; i >= 0; i--) {
      after = piece(pieces[i], after);
    }
    return after;
  };
  const piece = (it, next) => {
    const at = add();
    switch (it.kind) {
      case "char":
        state(at).moves.push({ takes: (char) => char === it.char, to: next });
        break;
      case "one":
        state(at).moves.push({ takes: notSlash, to: next });
        break;
      case "star":
        state(at).moves.push({ takes: notSlash, to: at });
        state(at).free.push(next);
        break;
      case "any":
        state(at).moves.push({ takes: anyChar, to: at });
        state(at).free.push(next);
        break;
      case "folders": {
        const inside = add();
        state(at).free.push(next, inside);
        state(inside).moves.push({ takes: anyChar, to: inside }, { takes: (char) => char === "/", to: next });
        break;
      }
      case "either":
        for (const option of it.options) {
          state(at).free.push(sequence(option, next));
        }
        break;
    }
    return at;
  };
  const start = sequence(parse(pattern), 0);
  const reach = (from) => {
    const seen = /* @__PURE__ */ new Set();
    const stack = [...from];
    while (stack.length > 0) {
      const index = stack.pop();
      if (!seen.has(index)) {
        seen.add(index);
        stack.push(...state(index).free);
      }
    }
    return seen;
  };
  return (path) => {
    let now = reach([start]);
    for (const char of path) {
      const next = [];
      for (const index of now) {
        for (const move of state(index).moves) {
          if (move.takes(char)) {
            next.push(move.to);
          }
        }
      }
      if (next.length === 0) {
        return false;
      }
      now = reach(next);
    }
    return now.has(0);
  };
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

// packages/sdk/src/index.ts
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

// packages/sdk/src/v3.ts
var EVENTS = ["write", "read", "prompt", "command", "output"];
var onWrite2 = onWrite;
var onRead2 = onRead;
var onPrompt2 = onPrompt;
var onCommand2 = onCommand;
var onOutput2 = onOutput;
export {
  EVENTS,
  findUp,
  findWord,
  lineAt,
  matchesGlob,
  matchesGlobs,
  mentioned,
  onCommand2 as onCommand,
  onOutput2 as onOutput,
  onPrompt2 as onPrompt,
  onRead2 as onRead,
  onWrite2 as onWrite
};
