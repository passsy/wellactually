// packages/sdk/src/index.ts
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
export {
  C_LIKE,
  EVENTS,
  HASH_LIKE,
  blankCommentsAndStrings,
  findWord,
  lineAt,
  mentioned,
  writtenLines
};
