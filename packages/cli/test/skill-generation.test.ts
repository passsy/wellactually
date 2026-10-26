import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";

const script = pathToFileURL(path.resolve(import.meta.dirname, "../../../scripts/sync-skills.mjs")).href;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-skills-"));
  roots.push(root);
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
  const sync = () => execFileSync(process.execPath, ["--input-type=module", "-e", `import { syncSkills } from ${JSON.stringify(script)}; syncSkills(process.argv[1]);`, root]);
  return { root, write, read, sync };
}

test("generates installable namespaced skills with their instructions and nested helpers", () => {
  const { root, write, read, sync } = fixture();
  const source = "---\nname: review\ndescription: Review changes\n---\nRead reviewer.md.\n";
  write("skills/review/SKILL.md", source);
  write("skills/review/reviewer.md", "Review instructions");
  write("skills/review/scripts/nested/helper.mjs", "export const answer = 42;");
  write("skills/not-a-skill/notes.md", "Not installed");
  sync();
  expect(read("opencode/skills/wellactually-review/SKILL.md")).toContain('name: wellactually-review\nmetadata:\n  opencode/slash: "true"');
  expect(read("opencode/skills/wellactually-review/reviewer.md")).toBe("Review instructions");
  expect(read("opencode/skills/wellactually-review/scripts/nested/helper.mjs")).toBe("export const answer = 42;");
  expect(fs.existsSync(path.join(root, "opencode/skills/wellactually-not-a-skill"))).toBe(false);
  expect(read("skills/review/SKILL.md")).toBe(source);
});

test("removes deleted skills, instructions and helpers without touching the rest of the package", () => {
  const { root, write, read, sync } = fixture();
  write("skills/review/SKILL.md", "---\nname: review\n---\nReview\n");
  write("skills/review/obsolete.md", "Old instructions");
  write("skills/review/scripts/obsolete.mjs", "Old helper");
  write("skills/removed/SKILL.md", "---\nname: removed\n---\nRemoved\n");
  write("opencode/README.md", "Package documentation");
  write("opencode/dist/plugin.mjs", "Plugin bundle");
  sync();
  fs.rmSync(path.join(root, "skills/review/obsolete.md"));
  fs.rmSync(path.join(root, "skills/review/scripts"), { recursive: true });
  fs.rmSync(path.join(root, "skills/removed"), { recursive: true });
  write("skills/review/reviewer.md", "Current instructions");
  sync();
  expect(fs.readdirSync(path.join(root, "opencode/skills"))).toEqual(["wellactually-review"]);
  expect(fs.readdirSync(path.join(root, "opencode/skills/wellactually-review")).sort()).toEqual(["SKILL.md", "reviewer.md"]);
  expect(read("opencode/skills/wellactually-review/reviewer.md")).toBe("Current instructions");
  expect(read("opencode/README.md")).toBe("Package documentation");
  expect(read("opencode/dist/plugin.mjs")).toBe("Plugin bundle");
  sync();
  expect(read("opencode/skills/wellactually-review/reviewer.md")).toBe("Current instructions");
});
