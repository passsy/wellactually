import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildBundle, fileCtx, runDetector } from "@wellactually/core/node";
import { diskFiles, projectRootOf } from "../src/board/files.ts";

/**
 * Bundles a detector whose one function `detect(ctx)` handles every event.
 * These tests are about the isolate, so they do not care which event it is.
 */
async function bundleOf(detector: string): Promise<string> {
  return buildBundle({
    "detector.ts": [
      `import { onCommand, onOutput, onPrompt, onRead, onWrite } from "@wellactually/sdk/v3";`,
      detector.replace(/export (function\*? detect)/, "$1"),
      "for (const on of [onWrite, onRead, onPrompt, onCommand, onOutput]) on({ detect });",
    ].join("\n"),
  });
}

describe("the disk, as a detector reads it", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-disk-")));
  const repo = path.join(base, "repo");
  const loose = path.join(base, "loose");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, "lib"));
  fs.mkdirSync(loose);
  fs.writeFileSync(path.join(repo, "pubspec.yaml"), "name: app\n");
  fs.writeFileSync(path.join(repo, "lib/a.dart"), "class A {}\n");
  fs.writeFileSync(path.join(repo, "image.bin"), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(loose, "pubspec.yaml"), "name: loose\n");
  fs.symlinkSync(path.join(loose, "pubspec.yaml"), path.join(repo, "lib/link.yaml"));
  const disk = diskFiles();

  test("text files are read and directories listed, in a git repository or not", () => {
    expect(disk.read(path.join(repo, "pubspec.yaml"))).toBe("name: app\n");
    expect(disk.read(path.join(loose, "pubspec.yaml"))).toBe("name: loose\n");
    expect(disk.read(path.join(repo, "lib/link.yaml"))).toBe("name: loose\n");
    expect(disk.stat(path.join(repo, "lib"))).toMatchObject({ kind: "dir" });
    expect(disk.list(repo)?.map((entry) => entry.name)).toEqual([".git", "image.bin", "lib", "pubspec.yaml"]);
  });

  test("what is missing, binary or not a directory is a file that does not exist", () => {
    expect(disk.read(path.join(repo, "missing"))).toBeNull();
    expect(disk.stat(path.join(repo, "missing"))).toBeNull();
    expect(disk.read(path.join(repo, "image.bin"))).toBeNull();
    expect(disk.read(path.join(repo, "lib"))).toBeNull();
    expect(disk.list(path.join(repo, "pubspec.yaml"))).toBeNull();
  });

  test("a real detector reads a folder that is no git repository", async () => {
    const bundle = await bundleOf(`
      import fs from "node:fs";
      import path from "node:path";
      export function detect(ctx) {
        return fs.readFileSync(path.join(path.dirname(ctx.file.path), "pubspec.yaml"), "utf8").includes("loose") ? [{ match: ctx.text }] : [];
      }
    `);
    const ctx = fileCtx("write", "main.dart", "void main() {}", undefined, { root: null, absolute: path.join(loose, "main.dart") });
    expect((await runDetector(bundle, ctx, undefined, disk)).findings).toEqual([{ match: "void main() {}" }]);
  });

  test("the project root is the repository of the file, and never a home directory", () => {
    expect(projectRootOf(path.join(repo, "lib"))).toBe(repo);
    expect(projectRootOf(loose)).toBeNull();
    const home = os.homedir();
    expect(projectRootOf(home) === home).toBe(false);
  });
});
