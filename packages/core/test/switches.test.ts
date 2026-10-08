import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { projectRoot, switchedOff, switchPrinciple, writeLockfile } from "../src/node.ts";

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
