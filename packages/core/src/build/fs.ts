import fs from "node:fs";
import path from "node:path";
import { vendorPackages, type FileMap } from "./bundle.ts";
import { isGitReference, parseGitHub, TAKEN_FROM, type PackageSource } from "./packages.ts";
import { assertFileMapSize } from "../principle/principle.ts";

/**
 * The principle directories read in this process, newest last. The installed
 * plugin carries no esbuild, so building looks for one where they live: a
 * repository of principles has it, as a dependency of the SDK.
 */
export const readFrom = new Set<string>();

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
  readFrom.add(dir);
  return vendorPackages(readPrincipleDir(dir), diskPackages(dir));
}
