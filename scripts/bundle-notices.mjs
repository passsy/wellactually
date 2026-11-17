import fs from "node:fs";
import path from "node:path";

const noticeFile = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;

/** Include the installed licenses of every npm package that contributes bundled code. */
export function bundleNotices(metafiles, root) {
  const packages = new Map();
  for (const metafile of metafiles) {
    for (const output of Object.values(metafile.outputs)) {
      for (const [input, contribution] of Object.entries(output.inputs)) {
        if (contribution.bytesInOutput === 0) continue;
        const absolute = path.resolve(root, input);
        // First-party sources are licensed by the package's own LICENSE.
        if (!absolute.split(path.sep).includes("node_modules")) continue;
        let directory = path.dirname(absolute);
        while (!fs.existsSync(path.join(directory, "package.json"))) {
          const parent = path.dirname(directory);
          if (parent === directory) throw new Error(`No package manifest for bundled input ${input}`);
          directory = parent;
        }
        packages.set(directory, JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")));
      }
    }
  }
  const sections = [];
  for (const [directory, pkg] of [...packages].sort((a, b) => `${a[1].name}@${a[1].version}`.localeCompare(`${b[1].name}@${b[1].version}`, "en"))) {
    const files = fs.readdirSync(directory).filter((name) => noticeFile.test(name) && fs.statSync(path.join(directory, name)).isFile()).sort();
    if (!files.some((name) => /^(?:licen[cs]e|copying)(?:[._-].*)?$/i.test(name))) {
      throw new Error(`Bundled package ${pkg.name}@${pkg.version} has no license file; review its redistribution notices before packaging`);
    }
    const texts = files.map((name) => {
      const text = fs.readFileSync(path.join(directory, name), "utf8");
      if (!text.trim()) throw new Error(`Bundled package ${pkg.name} has an empty ${name}`);
      return `${name}\n\n${text.trimEnd()}`;
    });
    sections.push(`${pkg.name}@${pkg.version}\n${"=".repeat(72)}\n\n${texts.join("\n\n")}`);
  }
  return "Third-party notices for code bundled into @wellactually/detector-sdk.\n" +
    "The SDK's own code is covered by LICENSE. Each dependency retains its license below.\n\n" + sections.join("\n\n\n") + "\n";
}
