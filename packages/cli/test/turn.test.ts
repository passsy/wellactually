import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { eventsOf } from "../src/hook/payload.ts";
import { absorbWrites, diffRepos, ensureSnapshot, forgetSnapshots, parsePatch, snapshotRepos } from "../src/hook/turn.ts";

/**
 * Real repositories in a temporary folder, because what is checked is how
 * git is driven: a private index and object store, and the repository left
 * as it was.
 */
function repo(files: Record<string, string> = {}): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-repo-")));
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  for (const [name, content] of Object.entries(files)) {
    write(root, name, content);
  }
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "--allow-empty", "-m", "start");
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function write(root: string, name: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), content);
}

const changes = (session: string, cwd: string) =>
  diffRepos(session, cwd).writes.map((change) => ({ file: change.file, lines: change.written.map((written) => `${written.line}:${written.text}`), isNew: change.isNew }));

beforeEach(() => {
  process.env.WELLACTUALLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-turns-"));
});

describe("what a shell command changed in a git repository", () => {
  test("is every added line of every file it touched, once", () => {
    const root = repo({ "lib/a.dart": "class A {}\n" });
    snapshotRepos("s", [root]);

    write(root, "lib/a.dart", "class A {}\nlate String name;\n");
    write(root, "lib/b.dart", "enum Color { red }\n");
    expect(changes("s", root)).toEqual([
      { file: path.join(root, "lib/a.dart"), lines: ["2:late String name;"], isNew: false },
      { file: path.join(root, "lib/b.dart"), lines: ["1:enum Color { red }"], isNew: true },
    ]);
    // Reported once: the snapshot moved on.
    expect(changes("s", root)).toEqual([]);
  });

  test("leaves the repository as it was", () => {
    const root = repo({ "a.txt": "a\n" });
    const index = fs.readFileSync(path.join(root, ".git/index"));
    const objects = git(root, "count-objects");
    snapshotRepos("s", [root]);
    write(root, "b.txt", "b\n");
    changes("s", root);

    expect(fs.readFileSync(path.join(root, ".git/index"))).toEqual(index);
    expect(git(root, "count-objects")).toBe(objects);
    expect(git(root, "status", "--porcelain")).toBe("?? b.txt\n");
  });

  test("says nothing about lines that were only removed", () => {
    const root = repo({ "a.txt": "one\ntwo\n" });
    snapshotRepos("s", [root]);
    write(root, "a.txt", "one\n");
    fs.rmSync(path.join(root, "a.txt"));
    expect(changes("s", root)).toEqual([]);
  });

  test("leaves out what a person changed between two prompts", () => {
    const root = repo({ "a.txt": "a\n" });
    snapshotRepos("s", [root]);
    write(root, "a.txt", "a\nby a person\n");
    snapshotRepos("s", [root]);
    write(root, "a.txt", "a\nby a person\nby the agent\n");
    expect(changes("s", root)).toEqual([{ file: path.join(root, "a.txt"), lines: ["3:by the agent"], isNew: false }]);
  });

  test("leaves out a file a file tool already reported", () => {
    const root = repo({ "a.txt": "a\n" });
    snapshotRepos("s", [root]);
    write(root, "a.txt", "a\nfrom Edit\n");
    absorbWrites("s", [path.join(root, "a.txt")]);
    write(root, "b.txt", "from the shell\n");
    expect(changes("s", root).map((change) => change.file)).toEqual([path.join(root, "b.txt")]);
  });

  test("leaves out files that came from the history when HEAD moved", () => {
    const root = repo({ "a.txt": "a\n" });
    git(root, "checkout", "--quiet", "-b", "other");
    write(root, "a.txt", "a\nfrom the other branch\n");
    git(root, "commit", "--quiet", "-am", "other");
    git(root, "checkout", "--quiet", "main");
    snapshotRepos("s", [root]);

    git(root, "checkout", "--quiet", "other");
    write(root, "c.txt", "written by the agent\n");
    expect(changes("s", root).map((change) => change.file)).toEqual([path.join(root, "c.txt")]);
  });

  test("covers every repository the session works in", () => {
    const first = repo();
    const second = repo({ "b.txt": "b\n" });
    snapshotRepos("s", [first]);
    // An edit in another repository starts following it.
    absorbWrites("s", [path.join(second, "b.txt")]);

    write(first, "a.txt", "a\n");
    write(second, "b.txt", "b\nbb\n");
    expect(changes("s", first).map((change) => change.file)).toEqual([path.join(first, "a.txt"), path.join(second, "b.txt")].sort());
  });

  test("starts without a prompt when a command runs first", () => {
    const root = repo({ "a.txt": "a\n" });
    ensureSnapshot("s", root);
    write(root, "a.txt", "a\nb\n");
    expect(changes("s", root)).toEqual([{ file: path.join(root, "a.txt"), lines: ["2:b"], isNew: false }]);
  });

  test("is nothing outside a git repository", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-plain-")));
    snapshotRepos("s", [dir]);
    write(dir, "a.txt", "a\n");
    expect(diffRepos("s", dir)).toEqual({ writes: [], roots: [], failures: [] });
  });

  test("is forgotten with the session", () => {
    const root = repo();
    snapshotRepos("s", [root]);
    forgetSnapshots("s");
    expect(fs.existsSync(path.join(process.env.WELLACTUALLY_HOME as string, "turns", "s"))).toBe(false);
  });
});

describe("a shell command in a git repository", () => {
  test("writes every file git saw change, whichever program changed it", () => {
    const root = repo({ "lib/a.dart": "class A {}\n" });
    snapshotRepos("s", [root]);
    write(root, "lib/a.dart", "class A {}\nlate String name;\n");
    write(root, "lib/gen.dart", "enum Generated { a }\n");

    const payload = { hook_event_name: "PostToolUse", tool_name: "Bash", cwd: root, session_id: "s", tool_input: { command: "echo 'late String name;' >> lib/a.dart && dart run build_runner build" } };
    const read = (absolute: string) => (fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : null);
    const events = eventsOf(payload, read, diffRepos("s", root));
    expect(events.map((ctx) => [ctx.file?.relativePath, ctx.file?.written.map((written) => written.line), ctx.file?.isNew])).toEqual([
      ["lib/a.dart", [2], false],
      ["lib/gen.dart", [1], true],
    ]);
  });
});

describe("parsePatch", () => {
  test("reads quoted paths and line numbers of each hunk", () => {
    const patch = [
      'diff --git "a/caf\\303\\251 x.txt" "b/caf\\303\\251 x.txt"',
      "index 1..2 100644",
      '--- "a/caf\\303\\251 x.txt"',
      '+++ "b/caf\\303\\251 x.txt"',
      "@@ -1,0 +2,2 @@",
      "+two",
      "+three",
      "@@ -9 +11 @@",
      "-old",
      "+new",
      "\\ No newline at end of file",
    ].join("\n");
    expect(parsePatch(patch)).toEqual([
      {
        path: "café x.txt",
        isNew: false,
        written: [
          { line: 2, text: "two" },
          { line: 3, text: "three" },
          { line: 11, text: "new" },
        ],
      },
    ]);
  });
});
