import fs from "node:fs";
import path from "node:path";
import { byteLength, type FileMap } from "./bundle.ts";
import { assertFileMapSize } from "./principle.ts";
import { scaffoldFiles } from "./scaffold.ts";

/** Reads a principle directory into a file map, the form every other function takes. */
export function readPrincipleDir(dir: string): FileMap {
  const files: FileMap = {};
  let total = 0;
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
      total += byteLength(content);
      files[relative] = content;
    }
  };
  walk(dir);
  assertFileMapSize(files, total);
  return files;
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
