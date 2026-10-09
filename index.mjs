// packages/sdk/src/index.ts
var API_VERSION = 2;
var EVENTS = ["write", "read", "prompt", "command"];
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
function* mentioned(ctx, names) {
  if (!ctx.isConversation) {
    return;
  }
  const haystack = ctx.text.toLowerCase();
  for (const name of names) {
    const at = findWord(haystack, name.toLowerCase());
    if (at === -1) {
      continue;
    }
    yield { evidence: ctx.text.slice(at, at + name.length), depth: "pointer" };
    return;
  }
}
function writtenLines(ctx) {
  return ctx.file?.written ?? [];
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
var C_LIKE = {
  lineComment: "//",
  blockComment: ["/*", "*/"],
  quotes: ['"', "'", "`"]
};
var HASH_LIKE = {
  lineComment: "#",
  quotes: ['"', "'"]
};
function blankCommentsAndStrings(text, syntax = C_LIKE) {
  const out = [];
  const quotes = syntax.quotes ?? [];
  let i = 0;
  while (i < text.length) {
    const char = text[i] ?? "";
    if (syntax.lineComment && text.startsWith(syntax.lineComment, i)) {
      while (i < text.length && text[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (syntax.blockComment && text.startsWith(syntax.blockComment[0], i)) {
      const close = text.indexOf(syntax.blockComment[1], i + syntax.blockComment[0].length);
      const end = close === -1 ? text.length : close + syntax.blockComment[1].length;
      for (; i < end; i++) {
        out.push(text[i] === "\n" ? "\n" : " ");
      }
      continue;
    }
    if (quotes.includes(char)) {
      out.push(char);
      i++;
      while (i < text.length && text[i] !== char) {
        if (text[i] === "\\" && i + 1 < text.length) {
          out.push(" ");
          i++;
        }
        out.push(text[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < text.length) {
        out.push(char);
        i++;
      }
      continue;
    }
    out.push(char);
    i++;
  }
  return out.join("");
}
var TEST_ROOT = "/project";
function fileCtx(event, relativePath, content, written, where = {}) {
  const relative = relativePath.replaceAll("\\", "/").replace(/^\.?\/+/, "");
  const root = where.root === void 0 ? TEST_ROOT : where.root;
  const path = (where.absolute ?? `${root ?? ""}/${relative}`).replaceAll("\\", "/");
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const lines = content.split("\n");
  const allLines = lines.map((text, index) => ({ line: index + 1, text }));
  return {
    event,
    file: {
      path,
      relativePath: relative,
      name,
      ext: dot > 0 ? name.slice(dot).toLowerCase() : "",
      content,
      lines,
      written: event === "read" ? [] : written ?? allLines,
      isNew: event === "write" && where.isNew === true
    },
    text: content,
    isUserPrompt: false,
    isCommand: false,
    isConversation: false,
    project: root
  };
}
function textCtx(event, text, root = TEST_ROOT) {
  return {
    event,
    file: null,
    text,
    isUserPrompt: event === "prompt",
    isCommand: event === "command",
    isConversation: true,
    project: root
  };
}
function locateWritten(content, fragments) {
  const lines = content.split("\n");
  const written = /* @__PURE__ */ new Map();
  for (const fragment of fragments) {
    if (fragment.trim() === "") {
      continue;
    }
    const at = content.indexOf(fragment);
    if (at !== -1) {
      const first = content.slice(0, at).split("\n").length;
      const count = fragment.split("\n").length;
      for (let line = first; line < first + count && line <= lines.length; line++) {
        written.set(line, lines[line - 1] ?? "");
      }
      continue;
    }
    for (const wanted of fragment.split("\n")) {
      const trimmed = wanted.trim();
      if (trimmed === "") {
        continue;
      }
      const index = lines.findIndex((line, lineIndex) => !written.has(lineIndex + 1) && line.trim() === trimmed);
      if (index !== -1) {
        written.set(index + 1, lines[index] ?? "");
      }
    }
  }
  return [...written.entries()].sort(([a], [b]) => a - b).map(([line, text]) => ({ line, text }));
}
export {
  API_VERSION,
  C_LIKE,
  EVENTS,
  HASH_LIKE,
  TEST_ROOT,
  blankCommentsAndStrings,
  fileCtx,
  findWord,
  lineAt,
  locateWritten,
  mentioned,
  textCtx,
  writtenLines
};
