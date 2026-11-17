// Build and pack the independently versioned detector SDK. Never publish the raw workspace.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { bundleNotices } from "./bundle-notices.mjs";
import { parseArgs } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: { version: { type: "string" } } });
const version = values.version ?? JSON.parse(fs.readFileSync(path.join(root, "packages/detector-sdk/package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("An exact SDK version is required");
const artifacts = path.join(root, ".artifacts/detector-sdk");
const target = path.join(artifacts, "package");
const esbuildRange = JSON.parse(fs.readFileSync(path.join(root, "packages/core/package.json"), "utf8")).dependencies.esbuild;
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
// One entry per detector API version: `v3.ts`. A principle imports the version it is written against.
const versions = fs
  .readdirSync(path.join(root, "packages/detector-sdk/src"))
  .filter((name) => /^v\d+\.ts$/.test(name))
  .map((name) => name.slice(0, -3))
  .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
const newest = versions.at(-1);
const write = (relative, content) => fs.writeFileSync(path.join(target, relative), content.endsWith("\n") ? content : `${content}\n`);

// The code. `test.mjs` carries the builder and the isolate; esbuild stays a dependency, because it is a native binary.
const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["esbuild"],
  banner: { js: 'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);' },
  legalComments: "eof",
  metafile: true,
  absWorkingDir: root,
  logLevel: "warning",
};
const metafiles = [];
async function bundle(options) {
  const result = await build(options);
  metafiles.push(result.metafile);
}
for (const version of versions) {
  await bundle({ ...shared, entryPoints: [path.join(root, `packages/detector-sdk/src/${version}.ts`)], outfile: path.join(target, `${version}.mjs`), banner: {} });
}
await bundle({ ...shared, entryPoints: [path.join(root, "packages/detector-sdk/src/test.node.ts")], outfile: path.join(target, "test.mjs") });
// `detect()` runs this as a child process to build the principle under test.
await bundle({ ...shared, entryPoints: [path.join(root, "packages/core/src/build-principle.ts")], outfile: path.join(target, "build-principle.mjs") });

// The types, for editors and for tsc. Declarations of the public files, with imports pointed at each other.
const types = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-sdk-types-"));
const sources = [...versions.map((version) => `${version}.ts`), "index.ts", "handlers.ts", "glob.ts", "events.ts", "test.node.ts"].map((name) => path.join(root, "packages/detector-sdk/src", name));
try {
  execFileSync(
    path.join(root, "node_modules/.bin/tsc"),
    ["--strict", "--declaration", "--emitDeclarationOnly", "--allowImportingTsExtensions", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2023", "--skipLibCheck", "--types", "node", "--outDir", types, ...sources],
    { stdio: "pipe" },
  );
  // Include transitive public declarations; fail on type errors before packing.
  for (const name of fs.readdirSync(types).filter((name) => name.endsWith(".d.ts"))) {
    const to = name === "test.node.d.ts" ? "test.d.ts" : name;
    write(to, fs.readFileSync(path.join(types, name), "utf8").replace(/(from\s+["']\.\/[^"']+)\.ts(["'])/g, "$1.js$2"));
  }
} finally {
  fs.rmSync(types, { recursive: true, force: true });
}

write(
  "package.json",
  JSON.stringify(
    {
      name: "@wellactually/detector-sdk",
      version,
      type: "module",
      description: "What a Well Actually principle's detector imports, and what its tests import to run under vitest.",
      license: "Apache-2.0",
      publishConfig: { access: "public", tag: "latest" },
      repository: { type: "git", url: "git+https://github.com/passsy/wellactually.git" },
      engines: { node: ">=22.18.0" },
      // No "." on purpose: the detector API version is part of the path.
      exports: Object.fromEntries(
        versions.flatMap((version) => [
          [`./${version}`, { types: `./${version}.d.ts`, default: `./${version}.mjs` }],
          [`./${version}/test`, { types: "./test.d.ts", default: "./test.mjs" }],
        ]),
      ),
      files: ["*.mjs", "*.d.ts", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.txt"],
      dependencies: { esbuild: esbuildRange },
    },
    null,
    2,
  ),
);

write(
  "README.md",
  `# @wellactually/detector-sdk

What a [Well Actually](https://github.com/passsy/wellactually) principle's detector imports, and what its tests import to run under vitest.

The source is in \`packages/detector-sdk\` on the \`main\` branch. This package contains compiled JavaScript and TypeScript declarations. Node >=22.18 is required.

## Use it in a repository of principles

\`\`\`bash
npm install --save-dev @wellactually/detector-sdk vitest
\`\`\`

\`\`\`json
{
  "type": "module",
  "scripts": { "test": "vitest run" }
}
\`\`\`

\`\`\`text
rules/
  avoid-late/
    principle.md
    detector.ts
    detector.test.ts
\`\`\`

\`\`\`bash
npm test
\`\`\`

\`\`\`bash
npx vitest run rules/avoid-late
\`\`\`

A detector imports the SDK from the detector API version it is written against.

\`\`\`ts
import { onWrite } from "@wellactually/detector-sdk/${newest}";
\`\`\`

A test builds the principle it is in and runs its real detector in the real sandbox.

\`\`\`ts
import { expect, test } from "vitest";
import { detect, write } from "@wellactually/detector-sdk/${newest}/test";

test("fires on a late field", () => {
  expect(detect(write("lib/user.dart", "late String name;"))).toEqual([{ line: 1 }]);
});
\`\`\`

## Versions

This is version ${version}.
The lockfile of your repository pins the npm package version it installed.
\`npm update @wellactually/detector-sdk\` moves to the newest.
The API is still changing.
That is why the version is part of the import path: \`@wellactually/detector-sdk/${newest}\` and \`@wellactually/detector-sdk/${newest}/test\`.
A principle that imports ${newest} keeps getting the event of ${newest}, also after newer versions exist, and the types under that path stay the types of ${newest}.
Bundled dependency licenses and upstream notices are included in \`THIRD_PARTY_NOTICES.txt\`.

This package has ${versions.map((version) => `\`${version}\``).join(" and ")}.
`,
);

write("THIRD_PARTY_NOTICES.txt", bundleNotices(metafiles, root));
write("LICENSE", fs.readFileSync(path.join(root, "LICENSE"), "utf8"));

const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", artifacts], { cwd: target, encoding: "utf8" }))[0];
fs.writeFileSync(path.join(artifacts, "pack.json"), JSON.stringify(packed, null, 2) + "\n");
console.log(`Packed ${packed.name}@${packed.version} at ${path.join(artifacts, packed.filename)}`);
