import fs from "node:fs";
import path from "node:path";
import type { ChangedFile, ReviewTarget } from "./review.ts";
import { parsePatch } from "../../../packages/cli/src/hook/turn.ts";

export interface InputOptions {
  paths?: string[];
  patch?: string;
  beforeRoot?: string;
  label?: string;
}
export interface CollectedInput {
  root: string;
  target: ReviewTarget;
  files: ChangedFile[];
  readable: { blocks: { file: string; text: string }[]; omitted: { file: string; reason: string }[] };
  context: string;
  read: (file: string, previous: boolean) => { content: string } | { reason: string };
}
const LIMIT = 512 * 1024;
const SKIP = new Set([".git", ".hg", ".svn", "node_modules", ".dart_tool", "build", "dist", "vendor", ".venv", "venv"]);

function safePath(root: string, file: string): string {
  const full = path.resolve(root, file);
  if (full === root || !full.startsWith(root + path.sep)) throw new Error(`File must be inside the review root: ${file}`);
  // Resolve symlinks before opening, including a symlinked parent folder.
  if (fs.existsSync(full)) {
    const real = fs.realpathSync(full);
    if (!real.startsWith(fs.realpathSync(root) + path.sep)) throw new Error(`File escapes review root through a symlink: ${file}`);
  }
  return full;
}
function read(root: string, file: string): { content: string } | { reason: string } {
  const full = safePath(root, file);
  try {
    if (!fs.statSync(full).isFile()) return { reason: "not a regular file" };
    if (fs.statSync(full).size > LIMIT) return { reason: "larger than 512 KB" };
    const content = fs.readFileSync(full, "utf8");
    return content.includes("\0") ? { reason: "binary" } : { content };
  } catch (error) { return { reason: `could not be read: ${error instanceof Error ? error.message : String(error)}` }; }
}
function names(root: string, selected: string[]): string[] {
  const found = new Set<string>();
  const walk = (full: string, explicit: boolean): void => {
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (fs.lstatSync(full).isSymbolicLink()) {
      if (explicit) throw new Error(`Select the real file instead of a symlink: ${rel}`);
      return;
    }
    if (full !== root) safePath(root, rel);
    if (fs.statSync(full).isDirectory()) {
      for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
        if (!SKIP.has(entry.name)) walk(path.join(full, entry.name), false);
      }
    } else if (fs.statSync(full).isFile()) found.add(rel);
  };
  for (const file of selected) {
    const full = path.resolve(root, file);
    if (full !== root) safePath(root, file);
    walk(full, true);
  }
  return [...found].sort();
}

/** Accept ordinary unified patches too, without invoking Git. Paths are relative to root. */
function normalizePatch(text: string): string {
  text = text.replace(/\r\n/g, "\n");
  if (text.includes("diff --git ")) return text;
  const lines = text.split("\n"), result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      const old = line.slice(4).split("\t")[0] as string;
      const next = (lines[i + 1] as string).slice(4).split("\t")[0] as string;
      const file = (next === "/dev/null" ? old : next).replace(/^[ab]\//, "");
      result.push(`diff --git a/${file} b/${file}`);
      if (old === "/dev/null") result.push("new file mode 100644");
      if (next === "/dev/null") result.push("deleted file mode 100644");
      result.push(`--- ${old === "/dev/null" ? old : "a/" + old.replace(/^a\//, "")}`);
      result.push(`+++ ${next === "/dev/null" ? next : "b/" + next.replace(/^b\//, "")}`);
      i++;
    } else result.push(line);
  }
  return result.join("\n");
}

/** Collect selected current files or an agent-supplied comparison, with no Git requirement. */
export function collectInput(cwd: string, options: InputOptions): CollectedInput {
  const root = fs.realpathSync(path.resolve(cwd));
  if (!fs.statSync(root).isDirectory()) throw new Error("Review root must be a directory");
  if (options.patch && options.paths?.length) throw new Error("Use either --patch or selected paths, not both");
  const after = new Map<string, { content: string } | { reason: string }>();
  const before = new Map<string, { content: string } | { reason: string }>();
  const omitted: { file: string; reason: string }[] = [];
  let files: ChangedFile[], blocks: { file: string; text: string }[];
  if (options.patch) {
    const patch = normalizePatch(fs.readFileSync(path.resolve(options.patch), "utf8"));
    const chunks = patch.split(/^(?=diff --git )/m).filter((text) => text.startsWith("diff --git "));
    files = chunks.map((text) => {
      const entry = parsePatch(text)[0];
      if (!entry) throw new Error("Patch has no readable unified file header");
      const from = /^rename from (.+)$/m.exec(text)?.[1];
      const to = /^rename to (.+)$/m.exec(text)?.[1];
      const file = entry.path || to;
      if (!file) throw new Error("Patch needs project-relative ---/+++ file headers");
      safePath(root, file);
      if (from) safePath(root, from);
      return { path: file, status: from && to ? "renamed" : entry.isDeleted ? "deleted" : entry.isNew ? "added" : "modified", ...(from ? { from } : {}), written: entry.written, removed: entry.removed };
    });
    if (patch.trim() && files.length === 0) throw new Error("Patch has no readable unified file headers; use project-relative paths");
    if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("Patch repeats a file; combine its hunks into one file block");
    blocks = chunks.map((text, index) => ({ file: (files[index] as ChangedFile).path, text: text.endsWith("\n") ? text : text + "\n" }));
    for (const file of files) {
      after.set(file.path, file.status === "deleted" ? { reason: "deleted in supplied patch" } : read(root, file.path));
      before.set(file.path, options.beforeRoot ? read(path.resolve(options.beforeRoot), file.from ?? file.path) : { reason: "previous full content not supplied; inspect the patch" });
      const now = after.get(file.path);
      if (file.status !== "deleted") {
        if (!now || !("content" in now)) throw new Error(`Reviewed content unavailable for ${file.path}; supply the actual after files`);
        const lines = now.content.replace(/\r\n/g, "\n").split("\n");
        if (file.written.some((line) => lines[line.line - 1] !== line.text)) throw new Error(`Patch does not match reviewed source lines in ${file.path}`);
      }
      const old = before.get(file.path);
      if (old && "content" in old && file.removed.some((line) => old.content.replace(/\r\n/g, "\n").split("\n")[line.line - 1] !== line.text)) throw new Error(`Patch does not match previous source lines in ${file.path}`);
    }
  } else {
    files = []; blocks = [];
    for (const file of names(root, options.paths?.length ? options.paths : ["."])) {
      const value = read(root, file); after.set(file, value);
      if (!("content" in value)) { omitted.push({ file, reason: value.reason }); continue; }
      const lines = value.content.split("\n");
      files.push({ path: file, status: "current", written: lines.map((text, index) => ({ line: index + 1, text })), removed: [] });
      // These are labeled source excerpts, not fabricated additions against an empty baseline.
      let text = `# Snapshot: ${file} (current contents; no comparison baseline)\n`;
      for (let start = 0; start < lines.length; start += 150) text += `@@ source lines ${start + 1}-${Math.min(start + 150, lines.length)} @@\n` + lines.slice(start, start + 150).join("\n") + "\n";
      blocks.push({ file, text });
    }
  }
  const target: ReviewTarget = { kind: options.patch ? "patch" : "snapshot", base: null, head: null, label: options.label ?? (options.patch ? "supplied comparison" : `current contents of ${(options.paths ?? ["."]).join(", ")}`) };
  const context = ["# Review scope", "", `Root: ${root}`, `Mode: ${target.kind}`, `Request: ${target.label}`, "", "Files:", ...files.map((file) => `- ${file.path}`), "", ...(options.patch ? [] : ["No baseline was supplied. Review present behavior; do not claim that a defect was introduced by a change.", "Common dependency, build and version-control directories and symlinks were excluded from folder discovery. Explicit files can be selected instead."])].join("\n") + "\n";
  return { root, target, files, readable: { blocks, omitted }, context, read: (file, previous) => (previous ? before : after).get(file) ?? { reason: "not supplied in review input" } };
}
