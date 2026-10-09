/**
 * What `node:path` resolves to inside the isolate: the POSIX half of it.
 *
 * Every path a detector sees has forward slashes, on every system, so this is
 * all it needs. It is string logic and never asks the host for anything.
 */

interface WithCwd {
  __cwd?: string;
}

export const sep = "/";
export const delimiter = ":";

/** The project root, which is what a relative path is relative to. */
function cwd(): string {
  return (globalThis as WithCwd).__cwd ?? "/";
}

export function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path);
}

export function normalize(path: string): string {
  if (path === "") {
    return ".";
  }
  const absolute = path.startsWith("/");
  const out: string[] = [];
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

export function join(...parts: string[]): string {
  return normalize(parts.filter((part) => part !== "").join("/"));
}

export function resolve(...parts: string[]): string {
  let resolved = "";
  for (let index = parts.length - 1; index >= 0 && !isAbsolute(resolved); index--) {
    const part = parts[index] ?? "";
    if (part !== "") {
      resolved = resolved === "" ? part : `${part}/${resolved}`;
    }
  }
  if (!isAbsolute(resolved)) {
    resolved = resolved === "" ? cwd() : `${cwd()}/${resolved}`;
  }
  const normalized = normalize(resolved);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

export function dirname(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const slash = trimmed.lastIndexOf("/");
  if (slash === -1) {
    return ".";
  }
  return slash === 0 ? "/" : trimmed.slice(0, slash);
}

export function basename(path: string, suffix = ""): string {
  const trimmed = path.replace(/\/+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return suffix !== "" && name.endsWith(suffix) && name !== suffix ? name.slice(0, -suffix.length) : name;
}

export function extname(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

export function relative(from: string, to: string): string {
  const a = resolve(from).split("/").filter(Boolean);
  const b = resolve(to).split("/").filter(Boolean);
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) {
    shared++;
  }
  return [...a.slice(shared).map(() => ".."), ...b.slice(shared)].join("/");
}

export interface ParsedPath {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
}

export function parse(path: string): ParsedPath {
  const base = basename(path);
  const ext = extname(path);
  const dir = dirname(path);
  return { root: path.startsWith("/") ? "/" : "", dir: dir === "." && !path.includes("/") ? "" : dir, base, ext, name: ext === "" ? base : base.slice(0, -ext.length) };
}

const path = { sep, delimiter, isAbsolute, normalize, join, resolve, dirname, basename, extname, relative, parse };

export const posix = path;
export default path;
