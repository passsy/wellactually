import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vendorPackages, type FileMap } from "./bundle.ts";
import { isGitReference, parseGitHub, TAKEN_FROM, type PackageSource } from "./packages.ts";
import { assertFileMapSize } from "./principle.ts";
import type { ProjectFiles } from "./project.ts";
import { scaffoldFiles } from "./scaffold.ts";

/** Reads a principle directory into a file map, the form every other function takes. */
export function readPrincipleDir(dir: string): FileMap {
  const files: FileMap = {};
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const relative = path.relative(dir, full).split(path.sep).join("/");
      const content = fs.readFileSync(full, "utf8");
      files[relative] = content;
    }
  };
  walk(dir);
  assertFileMapSize(files);
  return files;
}

/**
 * The packages installed for a principle on this machine: `node_modules` in
 * its folder, or in a folder above it, which is where npm puts them.
 */
export function diskPackages(dir: string): PackageSource {
  const roots = new Map<string, string | null>();
  const rootOf = (name: string): string | null => {
    const known = roots.get(name);
    if (known !== undefined) {
      return known;
    }
    let found: string | null = null;
    for (let current = path.resolve(dir); ; current = path.dirname(current)) {
      const candidate = path.join(current, "node_modules", name);
      if (fs.existsSync(path.join(candidate, "package.json"))) {
        found = candidate;
        break;
      }
      if (current === path.dirname(current)) {
        break;
      }
    }
    roots.set(name, found);
    return found;
  };
  return async (name, _version, file) => {
    const root = rootOf(name);
    if (root === null) {
      return null;
    }
    if (file === TAKEN_FROM) {
      return takenFrom(root, name);
    }
    const full = path.resolve(root, file);
    if (!full.startsWith(root + path.sep)) {
      return null;
    }
    try {
      if (!fs.statSync(full).isFile()) {
        return null;
      }
      return fs.readFileSync(full, "utf8");
    } catch {
      return null;
    }
  };
}

/**
 * The repository and commit npm installed a package from, read from the
 * record npm keeps inside `node_modules`. Null for a package from the npm
 * registry, and when there is no such record.
 */
function takenFrom(root: string, name: string): string | null {
  const modules = root.slice(0, root.length - name.length - 1);
  let lock: { packages?: Record<string, { resolved?: unknown }> };
  try {
    lock = JSON.parse(fs.readFileSync(path.join(modules, ".package-lock.json"), "utf8")) as typeof lock;
  } catch {
    return null;
  }
  const resolved = lock.packages?.[`node_modules/${name}`]?.resolved;
  // npm writes a repository as a git URL. A path is a package of the same repository, linked in by a workspace.
  if (typeof resolved !== "string" || !/^(?:git[+:]|github:)/.test(resolved) || !isGitReference(resolved)) {
    return null;
  }
  const github = parseGitHub(resolved);
  if (github?.ref) {
    return `github:${github.owner}/${github.repo}#${github.ref}`;
  }
  return resolved;
}

/**
 * A principle directory as it is submitted: its own files, and the code of
 * the packages it imports, taken from what is installed on this machine.
 */
export async function readPrinciple(dir: string): Promise<FileMap> {
  return vendorPackages(readPrincipleDir(dir), diskPackages(dir));
}

/** Writes a new principle to `parent/slug` and returns the directory. */
export function scaffold(slug: string, parent: string): string {
  const files = scaffoldFiles(slug);
  const dir = path.resolve(parent, slug);
  if (fs.existsSync(dir)) {
    throw new Error(`${dir} already exists`);
  }
  writeFileMap(dir, files);
  return dir;
}

/** Writes a principle's files below `dir`. Paths that would leave `dir` are refused. */
export function writeFileMap(dir: string, files: FileMap): void {
  for (const [name, content] of Object.entries(files)) {
    const file = path.resolve(dir, name);
    if (!file.startsWith(path.resolve(dir) + path.sep)) {
      throw new Error(`"${name}" is not a path inside the principle`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

/** A path with forward slashes, which is how every detector sees one. */
export function toPosix(file: string): string {
  return file.split(path.sep).join("/");
}

/** What marks the root of a project: the switches file of this tool, or a git repository. */
const ROOT_MARKERS = [".wellactually.json", ".git"];

/**
 * The root of the project a directory is in: the nearest one upwards that has
 * a `.wellactually.json`, else the nearest one with a `.git`. Null when there
 * is neither.
 *
 * Nothing tells a hook what "the project" is. A session started in one
 * repository edits files in others, so the answer belongs to the file an
 * event is about, and never to the session.
 */
export function findProjectRoot(from: string): string | null {
  const start = path.resolve(from);
  for (const marker of ROOT_MARKERS) {
    for (let dir = start; ; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, marker))) {
        return dir;
      }
      if (dir === path.dirname(dir)) {
        break;
      }
    }
  }
  return null;
}

/**
 * The project root of an event, or null when it has none.
 *
 * This is a convenience for detectors and for matching `globs`. It is not a
 * boundary: a detector reads files wherever they are. A home directory or a
 * whole disk is never called a project, even when somebody keeps a `.git`
 * there, because paths from it would say nothing about the code.
 */
export function projectRootOf(from: string): string | null {
  const root = findProjectRoot(from);
  if (root === null || root === os.homedir() || root === path.parse(root).root) {
    return null;
  }
  return root;
}

const MAX_READ_BYTES = 512 * 1024;

/**
 * The disk, for a detector to read: text files up to a size, and what
 * directories hold. Symlinks are followed. Whatever cannot be read is a file
 * that does not exist, so a detector never fails over a permission.
 */
export function diskFiles(): ProjectFiles {
  const kindOf = (stat: fs.Stats): "file" | "dir" | null => (stat.isFile() ? "file" : stat.isDirectory() ? "dir" : null);
  const statOf = (file: string): fs.Stats | null => {
    try {
      return fs.statSync(file);
    } catch {
      return null;
    }
  };
  return {
    read: (file) => {
      const stat = statOf(file);
      if (!stat?.isFile() || stat.size > MAX_READ_BYTES) {
        return null;
      }
      try {
        const content = fs.readFileSync(file, "utf8");
        return content.includes("\0") ? null : content;
      } catch {
        return null;
      }
    },
    stat: (file) => {
      const stat = statOf(file);
      const kind = stat ? kindOf(stat) : null;
      return stat && kind ? { kind, size: stat.size } : null;
    },
    list: (dir) => {
      if (!statOf(dir)?.isDirectory()) {
        return null;
      }
      let names: string[];
      try {
        names = fs.readdirSync(dir).sort();
      } catch {
        return null;
      }
      const entries: { name: string; kind: "file" | "dir" }[] = [];
      for (const name of names) {
        const stat = statOf(path.join(dir, name));
        const kind = stat ? kindOf(stat) : null;
        if (kind) {
          entries.push({ name, kind });
        }
      }
      return entries;
    },
  };
}
