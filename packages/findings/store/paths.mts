/**
 * Where findings live.
 *
 * Two roots. The per-repo one holds the findings themselves, next to the
 * review notes the skill writes by hand. The machine-wide one holds only a
 * registry, so a single UI process can serve every repo that has ever been
 * reviewed without being told where they are.
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/** Findings owned by Well Actually live here inside every reviewed repository. */
export const REVIEW_DIR = ".well-actually";

export const GLOBAL_ROOT =
  process.env.WELLACTUALLY_FINDINGS_HOME ?? join(homedir(), REVIEW_DIR);

export const REGISTRY_FILE = join(GLOBAL_ROOT, "registry.json");
/**
 * A target name that cannot escape the review directory.
 *
 * Targets are written by an agent from a branch name, and a branch can contain
 * a slash, a dot-dot, or an absolute path. Slashes collapse to dashes rather
 * than nesting, so `pr-123` and `feature/x` both name exactly one directory.
 */
export function slugTarget(target: string): string {
  const slug = target
    .trim()
    .replace(/[/\\]+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/-+/g, "-");
  if (slug === "" || slug === "." || slug === "..") {
    throw new Error(
      `target "${target}" does not name a directory. Use something like "pr-123" or a branch name.`,
    );
  }
  return slug;
}

/**
 * The repository a path belongs to.
 *
 * Falls back to the path itself when git does not answer, so a scratch
 * directory still gets findings instead of an error.
 */
export function repoRoot(from: string = process.cwd()): string {
  if (process.env.WELLACTUALLY_FINDINGS_ROOT) {
    return resolve(process.env.WELLACTUALLY_FINDINGS_ROOT);
  }
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: from,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return top === "" ? resolve(from) : resolve(top);
  } catch {
    return resolve(from);
  }
}

/** The commit a finding's anchor refers to, or "unknown" outside a repo. */
export function headCommit(root: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

export interface TargetPaths {
  repo: string;
  target: string;
  dir: string;
  findings: string;
  occurrences: string;
  meta: string;
}

export function targetPaths(repo: string, target: string): TargetPaths {
  const slug = slugTarget(target);
  const dir = join(repo, REVIEW_DIR, slug);
  return {
    repo,
    target: slug,
    dir,
    findings: join(dir, "findings"),
    occurrences: join(dir, "occurrences"),
    meta: join(dir, "target.json"),
  };
}

/** Keeps an anchor readable in reports and safe to join onto the repo root. */
export function repoRelative(repo: string, file: string): string {
  const absolute = isAbsolute(file) ? file : join(repo, file);
  const prefix = repo.endsWith(sep) ? repo : repo + sep;
  return absolute.startsWith(prefix) ? absolute.slice(prefix.length) : file;
}
