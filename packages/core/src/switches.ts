import fs from "node:fs";
import path from "node:path";
import { boardHome, readLockfile } from "./board.ts";

/**
 * Principles switched off on this machine.
 *
 * A principle can be off for one project or everywhere. Both are plain files
 * the user can read and edit, and neither is sent anywhere:
 *
 * - for a project: `.wellactually.json` at the project's root, which a team can commit
 * - everywhere: `disabled.json` in the Well Actually home directory
 *
 * A principle runs only when neither file lists it.
 */
export type Scope = "project" | "global";

const PROJECT_FILE = ".wellactually.json";

interface Switches {
  disabled?: string[];
}

function read(file: string): string[] {
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as Switches;
    return Array.isArray(stored.disabled) ? stored.disabled.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function write(file: string, disabled: string[]): void {
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    // A missing or unreadable file starts over.
  }
  const { disabled: _previous, ...rest } = stored;
  // A file that would hold nothing is removed, so switching on again leaves no trace in the project.
  if (disabled.length === 0 && Object.keys(rest).length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...rest, disabled: [...disabled].sort() }, null, 2)}\n`);
}

/**
 * The root of the project `cwd` is in: the nearest directory that already has
 * a `.wellactually.json`, else the nearest one with a `.git`, else `cwd` itself.
 */
export function projectRoot(cwd: string): string {
  const start = path.resolve(cwd);
  for (const marker of [PROJECT_FILE, ".git"]) {
    for (let dir = start; ; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, marker))) {
        return dir;
      }
      if (dir === path.dirname(dir)) {
        break;
      }
    }
  }
  return start;
}

function fileOf(scope: Scope, cwd: string): string {
  return scope === "global" ? path.join(boardHome(), "disabled.json") : path.join(projectRoot(cwd), PROJECT_FILE);
}

/** Which principles are off for work in `cwd`, and where each was switched off. */
export function switchedOff(cwd: string): Map<string, Scope[]> {
  const off = new Map<string, Scope[]>();
  for (const scope of ["project", "global"] as const) {
    for (const id of read(fileOf(scope, cwd))) {
      off.set(id, [...(off.get(id) ?? []), scope]);
    }
  }
  return off;
}

export interface SwitchResult {
  id: string;
  scope: Scope;
  /** The file that holds the switch. */
  file: string;
  /** Where the principle is still off after this change. Empty when it runs again. */
  stillOff: Scope[];
}

/** The id as the advisory board on this machine knows it, or null. `avoid-late` finds `passsy/avoid-late` when it is the only match. */
function knownId(wanted: string): string | null {
  const ids = readLockfile().entries.map((entry) => entry.id);
  if (ids.includes(wanted)) {
    return wanted;
  }
  const bySlug = ids.filter((id) => id.split("/")[1] === wanted);
  return bySlug.length === 1 ? (bySlug[0] as string) : null;
}

/** Switches a principle off or on again, for the project `cwd` is in or everywhere. */
export function switchPrinciple(wanted: string, on: boolean, scope: Scope, cwd: string): SwitchResult {
  const id = knownId(wanted);
  if (!id) {
    const known = readLockfile().entries.map((entry) => entry.id);
    throw new Error(`"${wanted}" is not on this machine's advisory board. ${known.length > 0 ? `It holds: ${known.join(", ")}.` : "It is empty; run `wellactually sync`."}`);
  }
  const file = fileOf(scope, cwd);
  const disabled = new Set(read(file));
  if (on) {
    disabled.delete(id);
  } else {
    disabled.add(id);
  }
  write(file, [...disabled]);
  return { id, scope, file, stillOff: switchedOff(cwd).get(id) ?? [] };
}
