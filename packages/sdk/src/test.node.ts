/**
 * What a principle's tests import on an author's machine.
 *
 * The tests are ordinary test files. `npm test` runs them with vitest, which
 * brings `test` and `expect`, and this module brings the rest: the events and
 * `detect`.
 *
 *     import { expect, test } from "vitest";
 *     import { detect, write } from "@wellactually/sdk/test";
 *
 *     test("fires on a late field", () => {
 *       expect(detect(write("lib/user.dart", "late String name;"))).toEqual([{ line: 1, evidence: "late String name;" }]);
 *     });
 *
 * `detect` builds the principle the test file belongs to and runs its real
 * detector in the real isolate, with the limits and the checks of a session.
 * The registry runs the same files again, inside the isolate, where this
 * module is replaced by `test.ts`. Both hand the call to the same function,
 * so a test that passes here passes there.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { answerDetect, detectorRunner, type BuiltPrinciple, type FileMap } from "@wellactually/core/node";
import type { DetectOptions } from "./events.ts";
import type { Ctx, Finding } from "./index.ts";

export { command, edit, prompt, read, source, write, type DetectOptions } from "./events.ts";

const runOnce = await detectorRunner();

/**
 * A detector gets 100 ms of wall clock, here as in a session. A test suite runs
 * many files at once, and a busy machine can use up that time before the
 * detector has done anything. So a run that was stopped for time is tried
 * once more. A detector that really is too slow is stopped both times.
 */
const run: typeof runOnce = (bundle, ctx, project, api) => {
  const first = runOnce(bundle, ctx, project, api);
  return first.error?.includes("ran longer than") ? runOnce(bundle, ctx, project, api) : first;
};
// The script that builds a principle: beside this file in the package that is installed from GitHub, in the core in this repository.
const beside = fileURLToPath(new URL("./build-principle.mjs", import.meta.url));
const builder = fs.existsSync(beside) ? beside : createRequire(import.meta.url).resolve("@wellactually/core/build-principle");
const self = fileURLToPath(import.meta.url);

interface Prepared {
  built: BuiltPrinciple;
  files: FileMap;
}

const prepared = new Map<string, Prepared>();

/** The files of the stack that called `detect`, nearest first. */
function callers(): string[] {
  const files: string[] = [];
  for (const line of (new Error().stack ?? "").split("\n").slice(1)) {
    const match = /\(?((?:file:\/\/)?(?:\/|[A-Za-z]:[\\/])[^()]*?):\d+:\d+\)?\s*$/.exec(line);
    if (!match?.[1]) {
      continue;
    }
    const file = match[1].startsWith("file://") ? fileURLToPath(match[1]) : match[1];
    if (file !== self && !files.includes(file)) {
      files.push(file);
    }
  }
  return files;
}

/** The directory of the principle a file belongs to: the nearest one upwards that has a `principle.md`. */
function principleDirOf(file: string): string | null {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "principle.md"))) {
      return dir;
    }
    if (dir === path.dirname(dir)) {
      return null;
    }
  }
}

function prepare(dir: string): Prepared {
  const known = prepared.get(dir);
  if (known) {
    return known;
  }
  const out = JSON.parse(execFileSync(process.execPath, [builder, dir], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })) as Prepared | { error: string };
  if ("error" in out) {
    throw new Error(`${path.basename(dir)} does not build: ${out.error}`);
  }
  prepared.set(dir, out);
  return out;
}

/**
 * What the detector reports for an event: the findings that passed the host's checks.
 *
 * It is empty when the detector's `events` or `globs` do not select the event,
 * exactly as in a session. It throws when the detector fails or reports a
 * finding the host would drop, so a test cannot pass on a broken detector.
 *
 * The principle is the one whose folder the calling test file is in.
 */
export function detect(event: Ctx, options: DetectOptions = {}): Finding[] {
  const dir = callers().map(principleDirOf).find((found) => found !== null);
  if (!dir) {
    throw new Error("detect() was called from a file that is in no principle. A principle is a folder with a principle.md and a detector.ts, and its tests live inside it.");
  }
  const { built, files } = prepare(dir);
  const answer = answerDetect(built, files, { event, options }, run);
  if ("error" in answer) {
    throw new Error(answer.error);
  }
  return answer.findings;
}
