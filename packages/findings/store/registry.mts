/**
 * The machine-wide list of repositories that have findings.
 *
 * The UI is one process serving every repo, and it has no way to discover
 * them: an MCP server only ever knows the repository it was started in. So
 * each server writes its own repo into this file as it works, and whichever
 * process ends up serving the UI reads all of them.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { GLOBAL_ROOT, REGISTRY_FILE } from "./paths.mts";

export interface RegistryRepo {
  path: string;
  targets: string[];
  /** ISO timestamp of the last write to any of its targets. */
  lastReview: string;
}

export interface Registry {
  repos: RegistryRepo[];
}

export function readRegistry(): Registry {
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as Registry;
    if (Array.isArray(parsed.repos)) return parsed;
  } catch {
    /* A missing registry starts empty. */
  }
  return { repos: [] };
}

/**
 * Records that `repo` has `target`.
 *
 * Read, merge, write, every time. Two servers racing here lose at worst one
 * repo entry, which the next mutation puts back, and that is a better trade
 * than a lock file nobody cleans up.
 */
export function upsertRegistry(
  repo: string,
  target: string,
  now: string,
): Registry {
  const registry = readRegistry();
  const existing = registry.repos.find((entry) => entry.path === repo);
  if (existing) {
    if (!existing.targets.includes(target)) existing.targets.push(target);
    existing.targets.sort();
    existing.lastReview = now;
  } else {
    registry.repos.push({ path: repo, targets: [target], lastReview: now });
  }
  registry.repos.sort((a, b) => a.path.localeCompare(b.path));
  write(registry);
  return registry;
}

function write(registry: Registry): void {
  mkdirSync(GLOBAL_ROOT, { recursive: true });
  const temp = `${REGISTRY_FILE}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`);
  renameSync(temp, REGISTRY_FILE);
}
