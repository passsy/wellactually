/**
 * Which repository this server writes findings into.
 *
 * The working directory is a bad answer to that question. A host is free to
 * start a plugin's MCP server from the plugin's own directory, and when that
 * directory happens to sit inside some other checkout, git answers confidently
 * with the wrong repository: findings from reviewing project A get written
 * into project B. That is worse than not knowing.
 *
 * So the working directory is only trusted when it is not a plugin
 * installation, the client's roots override it when offered, and an unknown
 * workspace is an empty string that every tool turns into a question rather
 * than a guess.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./paths.mts";

export interface Workspace {
  /** The repository, or "" when this process cannot tell. */
  repo: string;
}

export function currentWorkspace(): Workspace {
  const start = process.cwd();
  return { repo: isPluginInstall(start) ? "" : repoRoot(start) };
}

/**
 * The server was started inside an installed plugin, not inside a project.
 *
 * Walks up from where it started, because the answer has to come from the
 * directory the host chose rather than from wherever git eventually leads.
 * Whichever marker appears first decides: history means a checkout someone
 * works in, a plugin manifest means an installation. This repository has both
 * at its root, so working on the plugins themselves still counts as a project.
 */
export function isPluginInstall(dir: string): boolean {
  let current = resolve(dir);
  for (;;) {
    if (existsSync(join(current, ".git"))) return false;
    if (
      existsSync(join(current, ".claude-plugin")) ||
      existsSync(join(current, ".codex-plugin"))
    ) {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Adopts the first usable root the client offered.
 *
 * Clients hand over the directories the user is actually working in. The
 * first one that is a local path wins; a client that offers none, or offers
 * only remote URIs, leaves the working-directory answer in place, including
 * when that answer is "I cannot tell".
 */
export function adoptRoots(
  workspace: Workspace,
  roots: { uri: string }[],
): void {
  for (const root of roots) {
    if (!root.uri.startsWith("file://")) continue;
    try {
      workspace.repo = repoRoot(fileURLToPath(root.uri));
      return;
    } catch {
      // A URI this process cannot turn into a path is not a workspace.
    }
  }
}
