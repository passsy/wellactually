import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { API_VERSION } from "@wellactually/sdk";
import { buildBundle } from "@wellactually/core/node";
import { writeCached, writeLockfile } from "../src/board/board.ts";
import { boardOffIn, projectRoot, switchedOff, switchPrinciple, switchProject } from "../src/board/switches.ts";
import { runHook } from "../src/hook/hook.ts";

describe("switching a principle off on this machine", () => {
  let project: string;

  beforeEach(() => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-switches-")));
    process.env.WELLACTUALLY_HOME = path.join(base, "home");
    project = path.join(base, "project");
    fs.mkdirSync(path.join(project, ".git"), { recursive: true });
    fs.mkdirSync(path.join(project, "lib/src"), { recursive: true });
    writeLockfile({
      syncedAt: null,
      entries: [
        { id: "ana/grid", version: 1, hash: "a".repeat(64), enabled: true },
        { id: "joseph/names", version: 1, hash: "b".repeat(64), enabled: true },
      ],
    });
  });

  test("for a project it is recorded at the project's root, from anywhere inside it", () => {
    const result = switchPrinciple("ana/grid", false, "project", path.join(project, "lib/src"));
    expect(result).toEqual({ id: "ana/grid", scope: "project", file: path.join(project, ".wellactually.json"), stillOff: ["project"] });
    expect(JSON.parse(fs.readFileSync(result.file, "utf8"))).toEqual({ disabled: ["ana/grid"] });
    expect([...switchedOff(project)]).toEqual([["ana/grid", ["project"]]]);
    expect(projectRoot(path.join(project, "lib/src"))).toBe(project);
  });

  test("another project is not affected", () => {
    switchPrinciple("ana/grid", false, "project", project);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-other-"));
    expect(switchedOff(other).size).toBe(0);
  });

  test("globally it is off in every project", () => {
    switchPrinciple("joseph/names", false, "global", project);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-other-"));
    expect([...switchedOff(other)]).toEqual([["joseph/names", ["global"]]]);
    expect(fs.existsSync(path.join(project, ".wellactually.json"))).toBe(false);
  });

  test("switching it on in one scope says when the other still holds it off", () => {
    switchPrinciple("ana/grid", false, "project", project);
    switchPrinciple("ana/grid", false, "global", project);
    expect(switchPrinciple("ana/grid", true, "project", project).stillOff).toEqual(["global"]);
    expect(switchPrinciple("ana/grid", true, "global", project).stillOff).toEqual([]);
    expect(switchedOff(project).size).toBe(0);
  });

  test("the name alone is enough when only one expert has it", () => {
    expect(switchPrinciple("grid", false, "project", project).id).toBe("ana/grid");
  });

  test("a principle that is not on the advisory board is refused, with what is", () => {
    expect(() => switchPrinciple("ana/unknown", false, "project", project)).toThrow(
      '"ana/unknown" is not on this machine\'s advisory board. It holds: ana/grid, joseph/names.',
    );
  });

  test("other settings in the project file are kept", () => {
    fs.writeFileSync(path.join(project, ".wellactually.json"), JSON.stringify({ note: "ours" }));
    switchPrinciple("ana/grid", false, "project", project);
    expect(JSON.parse(fs.readFileSync(path.join(project, ".wellactually.json"), "utf8"))).toEqual({ note: "ours", disabled: ["ana/grid"] });
  });
});

describe("switching the whole advisory board off in a project", () => {
  let base: string;
  let project: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-board-off-")));
    process.env.WELLACTUALLY_HOME = path.join(base, "home");
    project = path.join(base, "project");
    fs.mkdirSync(path.join(project, ".git"), { recursive: true });
    fs.mkdirSync(path.join(project, "lib/src"), { recursive: true });
  });

  test("is recorded on this machine, not in the project, and covers everything inside it", () => {
    expect(switchProject(false, path.join(project, "lib/src"))).toEqual({ project, unchanged: false, stillOffIn: null });
    expect(fs.readdirSync(project)).toEqual([".git", "lib"]);
    expect(JSON.parse(fs.readFileSync(path.join(base, "home/disabled.json"), "utf8"))).toEqual({ projects: [project] });
    expect(boardOffIn(project)).toBe(project);
    expect(boardOffIn(path.join(project, "lib/src"))).toBe(project);
    expect(boardOffIn(fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-other-")))).toBeNull();
  });

  test("switching it on again leaves no trace and keeps the principles switched off everywhere", () => {
    writeLockfile({ syncedAt: null, entries: [{ id: "ana/grid", version: 1, hash: "a".repeat(64), enabled: true }] });
    switchPrinciple("ana/grid", false, "global", project);
    switchProject(false, project);
    expect(switchProject(true, project)).toEqual({ project, unchanged: false, stillOffIn: null });
    expect(JSON.parse(fs.readFileSync(path.join(base, "home/disabled.json"), "utf8"))).toEqual({ disabled: ["ana/grid"] });
    expect(boardOffIn(project)).toBeNull();
    switchPrinciple("ana/grid", true, "global", project);
    expect(fs.existsSync(path.join(base, "home/disabled.json"))).toBe(false);
  });

  test("says when it was already in that state", () => {
    expect(switchProject(true, project).unchanged).toBe(true);
    switchProject(false, project);
    expect(switchProject(false, project).unchanged).toBe(true);
  });

  test("a git worktree counts as the checkout it belongs to, wherever it lives", () => {
    const worktree = path.join(base, "elsewhere/feature");
    fs.mkdirSync(path.join(project, ".git/worktrees/feature"), { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(project, ".git/worktrees/feature")}\n`);
    switchProject(false, worktree);
    expect(boardOffIn(project)).toBe(project);
    expect(boardOffIn(worktree)).toBe(project);
  });

  test("switching on a folder inside a project that is off says where it is still off", () => {
    const inner = path.join(project, "packages/app");
    fs.mkdirSync(path.join(inner, ".git"), { recursive: true });
    switchProject(false, project);
    expect(switchProject(true, inner)).toEqual({ project: inner, unchanged: true, stillOffIn: project });
  });

  test("the hook shows no advice there, and still does in other projects", async () => {
    const bundle = await buildBundle({ "detector.ts": `import { onPrompt } from "@wellactually/sdk/v3"; onPrompt({ detect: () => [{ match: "enum" }] });` });
    const manifest = { title: "No enums", summary: "Avoid enums.", tags: [], events: ["prompt" as const], globs: [], handlers: [{ event: "prompt" as const, globs: [] }], api: API_VERSION };
    writeCached({ id: "ana/no-enums", version: 4, hash: "a".repeat(64), manifest, advice: "Avoid enums.", bundle });
    writeLockfile({ syncedAt: null, entries: [{ id: "ana/no-enums", version: 4, hash: "a".repeat(64), enabled: true }] });
    const other = path.join(base, "other");
    fs.mkdirSync(path.join(other, ".git"), { recursive: true });
    const prompt = (cwd: string, session: string) => runHook(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, cwd, prompt: "add an enum" }));
    process.env.WELLACTUALLY_WORKERS = "0";
    process.env.WELLACTUALLY_GIT = "0";
    try {
      switchProject(false, project);
      expect(await prompt(path.join(project, "lib"), "s1")).toBe("");
      expect(await prompt(other, "s2")).toContain("ana/no-enums");
      switchProject(true, project);
      expect(await prompt(project, "s3")).toContain("ana/no-enums");
    } finally {
      delete process.env.WELLACTUALLY_WORKERS;
      delete process.env.WELLACTUALLY_GIT;
    }
  });
});
