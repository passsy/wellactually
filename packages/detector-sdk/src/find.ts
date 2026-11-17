/**
 * Looking around the project from where an event happened.
 *
 * A detector reads files with `node:fs`, and may read any text file. What it
 * usually wants to know first is what kind of project it is in, and the
 * answer lies in a file somewhere above: a `pubspec.yaml`, a `package.json`.
 */
import { existsSync } from "./fs.ts";
import { dirname, join } from "./path.ts";

/**
 * The nearest file called `name`, looking in `from` and then in every folder
 * above it, as an absolute path. Null when there is none.
 *
 *     findUp("pubspec.yaml", event.cwd)                  // for a prompt
 *     findUp("pubspec.yaml", path.dirname(event.file.path)) // for a file
 */
export function findUp(name: string, from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
    if (dir === dirname(dir)) {
      return null;
    }
  }
}
