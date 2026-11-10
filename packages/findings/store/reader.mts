/**
 * What the reader has done to a finding, as opposed to what it is.
 *
 * Two maps, both of finding id to a timestamp, and both deliberately outside
 * the finding itself. Reading is not a decision and neither is meaning to
 * come back to something, so neither belongs in the record of what the review
 * found and what the user ruled.
 *
 * Which findings have been read.
 *
 * A queue that grows while you are working it needs to say which rows are new,
 * because "undecided" stops meaning anything once it holds both the fifty you
 * have never looked at and the three you looked at and left open on purpose.
 *
 * One file per target rather than a field on each finding, for two reasons.
 * Reading is not a decision, so it does not belong in the record of what the
 * review found and what the user ruled; and a write to a finding wakes every
 * open inbox, which is too much to spend on moving a cursor down one row.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { TargetPaths } from "./paths.mts";

/** Finding id to the ISO timestamp it was read at. */
export type { SeenMap } from "../model/types.mts";
export { isUnseen } from "../model/unread.mts";
import type { SeenMap } from "../model/types.mts";

export function seenPath(paths: TargetPaths): string {
  return join(paths.dir, "seen.json");
}

/**
 * Which findings the reader means to come back to.
 *
 * Its own axis, because it crosses every other one: a finding can be
 * undecided and marked, accepted and marked, or reported and marked, and it
 * says nothing about the finding — only that whoever is reading it is not
 * finished with it. A question they mean to ask, a decision they are not
 * ready to make.
 */
export function followPath(paths: TargetPaths): string {
  return join(paths.dir, "follow.json");
}

export function readFollow(paths: TargetPaths): SeenMap {
  return readMap(followPath(paths));
}

/** Marks findings for follow-up, or takes the mark off. */
export function markFollow(
  paths: TargetPaths,
  ids: string[],
  at: string | null,
): SeenMap {
  return writeMap(followPath(paths), ids, at);
}

export function readSeen(paths: TargetPaths): SeenMap {
  return readMap(seenPath(paths));
}

function readMap(path: string): SeenMap {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return {};
    const map: SeenMap = {};
    for (const [id, at] of Object.entries(parsed)) {
      if (typeof at === "string") map[id] = at;
    }
    return map;
  } catch {
    // Reading state is worth nothing next to the findings themselves, so a
    // damaged file reads as "nothing has been read" rather than as an error.
    return {};
  }
}

let writes = 0;

/**
 * Records that these ids have been read, or takes that back.
 *
 * Both directions, because a reader who has looked at something and decided
 * to come back to it has nowhere else to put that: the verdict axis is for
 * what he decided and the resolution axis is for the code, and "not yet" is
 * neither. Taking the mark off is a delete rather than a timestamp, so an
 * unread finding is exactly one that is absent here however it got that way.
 *
 * Read, merge, write. Two browsers on the same target lose at worst one mark,
 * and the next move puts it back; a lock around a read receipt would cost more
 * than what it protects.
 */
export function markSeen(
  paths: TargetPaths,
  ids: string[],
  at: string | null,
): SeenMap {
  return writeMap(seenPath(paths), ids, at);
}

/**
 * Read, merge, write.
 *
 * Two browsers on the same target lose at worst one mark, and the next move
 * puts it back; a lock around a read receipt would cost more than what it
 * protects.
 */
function writeMap(path: string, ids: string[], at: string | null): SeenMap {
  const map = readMap(path);
  for (const id of ids) {
    if (at === null) delete map[id];
    else map[id] = at;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${writes++}.tmp`;
  writeFileSync(temp, `${JSON.stringify(map, null, 2)}\n`);
  renameSync(temp, path);
  return map;
}
