import fs from "node:fs";
import path from "node:path";

// OpenCode/pi install these generated copies without the repository sources.
// Recreate the tree so deleted skills, instructions and helpers disappear too.
export function syncSkills(root) {
  const skills = path.join(root, "skills");
  const destination = path.join(root, "opencode", "skills");
  fs.rmSync(destination, { recursive: true, force: true });
  for (const name of fs.readdirSync(skills)) {
    const source = path.join(skills, name, "SKILL.md");
    if (!fs.existsSync(source)) {
      continue;
    }
    const copy = path.join(destination, `wellactually-${name}`);
    fs.mkdirSync(copy, { recursive: true });
    fs.writeFileSync(path.join(copy, "SKILL.md"), fs.readFileSync(source, "utf8").replace(/^name: (.+)$/m, "name: wellactually-$1\nmetadata:\n  opencode/slash: \"true\""));
    if (fs.existsSync(path.join(skills, name, "scripts"))) {
      // Installed helpers run the generated bundles; authored sources stay in the source tree.
      fs.cpSync(path.join(skills, name, "scripts"), path.join(copy, "scripts"), {
        recursive: true,
        filter: (file) => fs.statSync(file).isDirectory() || path.extname(file) === ".mjs",
      });
    }
    // A skill that comes in several files, such as review with its steps, needs the rest of them beside it.
    for (const file of fs.readdirSync(path.join(skills, name))) {
      if (file !== "SKILL.md" && file.endsWith(".md")) {
        fs.copyFileSync(path.join(skills, name, file), path.join(copy, file));
      }
    }
  }
}
