/**
 * What a file is written in, judged by its name.
 *
 * Pure, and its own module, because two very different things need the same
 * answer: the highlighter, which turns it into a grammar, and the reporter,
 * which puts it after the three backticks of a snippet on its way to an
 * issue. Neither should be asking the other, and the reporter must not be
 * importing a browser bundle to find out that a file is Dart.
 *
 * A name and nothing else. Reading the file to guess would be more accurate
 * and is the wrong trade: this runs over every row of a queue and over code
 * that may not be on this machine any more.
 */

/** What a file's name says it is written in, or null for "just text". */
export function languageOf(path: string): string | null {
  const name = path.split("/").pop() ?? "";
  // Named rather than suffixed, and every one of them is real code: an iOS
  // checkout has a Podfile, a release pipeline has a Fastfile, and neither
  // has a dot in it to read an extension out of.
  const named = NAMED[name];
  if (named) return named;
  const ext = name.includes(".")
    ? (name.split(".").pop()?.toLowerCase() ?? "")
    : "";
  return EXT[ext] ?? null;
}

const NAMED: Record<string, string> = {
  Dockerfile: "docker",
  Containerfile: "docker",
  Podfile: "ruby",
  Gemfile: "ruby",
  Rakefile: "ruby",
  Brewfile: "ruby",
  Fastfile: "ruby",
  Appfile: "ruby",
  Matchfile: "ruby",
};

const EXT: Record<string, string> = {
  dart: "dart",
  py: "python",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  java: "java",
  m: "objectivec",
  mm: "objectivec",
  // Ambiguous between C, C++ and Objective-C. C is the part all three agree
  // on, and the keywords the other two add are a smaller loss than picking
  // one of them and being wrong about most files called .h.
  h: "c",
  hpp: "cpp",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  cs: "csharp",
  go: "go",
  rs: "rust",
  rb: "ruby",
  php: "php",
  sql: "sql",
  gradle: "groovy",
  groovy: "groovy",
  graphql: "graphql",
  gql: "graphql",
  scss: "scss",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  properties: "properties",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  yaml: "yaml",
  yml: "yaml",
  json: "json",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  md: "markdown",
  html: "markup",
  xml: "markup",
  // All XML, all already registered, and none of it was reaching the grammar.
  // An iOS checkout alone carries hundreds of these.
  svg: "markup",
  plist: "markup",
  storyboard: "markup",
  xib: "markup",
  xcscheme: "markup",
  xcsettings: "markup",
  css: "css",
  diff: "diff",
  patch: "diff",
};
