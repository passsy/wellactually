/**
 * What `node:fs` resolves to inside the isolate: the reading half of it.
 *
 * A detector has no file system of its own. Each call here is a question to
 * the host, which reads the file for it. A file that is not text, is very
 * large or cannot be read looks like a file that does not exist.
 *
 * Only the synchronous calls exist, because a detector is synchronous.
 * Nothing can be written.
 */

interface Host {
  __fs?: (request: string) => string;
}

interface Entry {
  name: string;
  kind: "file" | "dir";
}

type Answer =
  | { text: string }
  | { stat: { kind: "file" | "dir"; size: number } }
  | { entries: Entry[] }
  | { error: { code: string; message: string } };

function ask(op: "read" | "stat" | "list", path: string): Answer {
  const host = (globalThis as Host).__fs;
  if (!host) {
    return { error: { code: "ENOENT", message: `ENOENT: no such file or directory, ${op} '${path}'` } };
  }
  return JSON.parse(host(JSON.stringify({ op, path: String(path) }))) as Answer;
}

function fail(error: { code: string; message: string }): never {
  throw Object.assign(new Error(error.message), { code: error.code });
}

/** The file as text. The encoding is always UTF-8, whatever is passed. */
export function readFileSync(path: string, _options?: unknown): string {
  const answer = ask("read", path);
  if ("error" in answer) {
    fail(answer.error);
  }
  return (answer as { text: string }).text;
}

export function existsSync(path: string): boolean {
  return !("error" in ask("stat", path));
}

export interface Stats {
  size: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export function statSync(path: string, options?: { throwIfNoEntry?: boolean }): Stats | undefined {
  const answer = ask("stat", path);
  if ("error" in answer) {
    if (options?.throwIfNoEntry === false) {
      return undefined;
    }
    fail(answer.error);
  }
  const { kind, size } = (answer as { stat: { kind: "file" | "dir"; size: number } }).stat;
  return { size, isFile: () => kind === "file", isDirectory: () => kind === "dir", isSymbolicLink: () => false };
}

/** Symlinks are resolved by the host, so this is `statSync`. */
export const lstatSync = statSync;

export interface Dirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
export function readdirSync(path: string, options?: { withFileTypes?: false } | string): string[];
export function readdirSync(path: string, options?: { withFileTypes?: boolean } | string): string[] | Dirent[] {
  const answer = ask("list", path);
  if ("error" in answer) {
    fail(answer.error);
  }
  const entries = (answer as { entries: Entry[] }).entries;
  if (typeof options === "object" && options.withFileTypes) {
    return entries.map((entry) => ({ name: entry.name, isFile: () => entry.kind === "file", isDirectory: () => entry.kind === "dir", isSymbolicLink: () => false }));
  }
  return entries.map((entry) => entry.name);
}

function readOnly(name: string): () => never {
  return () => {
    throw Object.assign(new Error(`EROFS: read-only file system, ${name}. A detector can read the project and cannot change it.`), { code: "EROFS" });
  };
}

export const writeFileSync = readOnly("writeFileSync");
export const appendFileSync = readOnly("appendFileSync");
export const mkdirSync = readOnly("mkdirSync");
export const rmSync = readOnly("rmSync");
export const unlinkSync = readOnly("unlinkSync");
export const renameSync = readOnly("renameSync");
export const copyFileSync = readOnly("copyFileSync");

export default { readFileSync, existsSync, statSync, lstatSync, readdirSync, writeFileSync, appendFileSync, mkdirSync, rmSync, unlinkSync, renameSync, copyFileSync };
