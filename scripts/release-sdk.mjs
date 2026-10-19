// Writes the SDK as an installable package into a directory.
//
//   node scripts/release-sdk.mjs ../wellactually-sdk
//
// The SDK is not on npm yet, because its API is still moving. Until it is, a
// repository of principles installs it from GitHub:
//
//   npm install --save-dev github:passsy/wellactually#sdk vitest
//
// npm can only install the root of a repository, and Node does not run
// TypeScript from node_modules. So this script writes the SDK built, with
// its package.json at the root, and the result is committed to the `sdk`
// branch of this repository. The directory is a checkout of that
// branch. Everything in it except .git is replaced.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const target = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!target) {
  console.error("Usage: node scripts/release-sdk.mjs <checkout of the sdk branch>");
  process.exit(2);
}
if (target === root || root.startsWith(target + path.sep) || target.startsWith(root + path.sep)) {
  console.error("The target must be outside this repository.");
  process.exit(2);
}

const version = JSON.parse(fs.readFileSync(path.join(root, "packages/cli/package.json"), "utf8")).version;
const esbuildRange = JSON.parse(fs.readFileSync(path.join(root, "packages/core/package.json"), "utf8")).dependencies.esbuild;

fs.mkdirSync(target, { recursive: true });
for (const entry of fs.readdirSync(target)) {
  if (entry !== ".git") {
    fs.rmSync(path.join(target, entry), { recursive: true, force: true });
  }
}
// One entry per detector API version: `v3.ts`. A principle imports the version it is written against.
const versions = fs
  .readdirSync(path.join(root, "packages/sdk/src"))
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
  legalComments: "none",
  logLevel: "warning",
};
for (const version of versions) {
  await build({ ...shared, entryPoints: [path.join(root, `packages/sdk/src/${version}.ts`)], outfile: path.join(target, `${version}.mjs`), banner: {} });
}
await build({ ...shared, entryPoints: [path.join(root, "packages/sdk/src/test.node.ts")], outfile: path.join(target, "test.mjs") });
// `detect()` runs this as a child process to build the principle under test.
await build({ ...shared, entryPoints: [path.join(root, "packages/core/src/build-principle.ts")], outfile: path.join(target, "build-principle.mjs") });

// The types, for editors and for tsc. Declarations of the public files, with imports pointed at each other.
const types = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-sdk-types-"));
const sources = [...versions.map((version) => `${version}.ts`), "index.ts", "handlers.ts", "glob.ts", "events.ts", "test.node.ts"].map((name) => path.join(root, "packages/sdk/src", name));
try {
  execFileSync(
    path.join(root, "node_modules/.bin/tsc"),
    ["--declaration", "--emitDeclarationOnly", "--allowImportingTsExtensions", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2023", "--skipLibCheck", "--types", "node", "--outDir", types, ...sources],
    { stdio: "pipe" },
  );
} catch {
  // tsc also reports on the core, which these files import and which is checked by `npm run typecheck`. The declarations are written regardless.
}
for (const [from, to] of [...versions.map((version) => [`${version}.d.ts`, `${version}.d.ts`]), ["index.d.ts", "index.d.ts"], ["handlers.d.ts", "handlers.d.ts"], ["glob.d.ts", "glob.d.ts"], ["events.d.ts", "events.d.ts"], ["test.node.d.ts", "test.d.ts"]]) {
  const file = path.join(types, from);
  if (!fs.existsSync(file)) {
    throw new Error(`tsc did not write ${from}`);
  }
  write(to, fs.readFileSync(file, "utf8").replace(/"\.\/(index|handlers|glob|events)\.ts"/g, '"./$1.js"'));
}
fs.rmSync(types, { recursive: true, force: true });

write(
  "package.json",
  JSON.stringify(
    {
      name: "@wellactually/sdk",
      version,
      type: "module",
      description: "What a Well Actually principle's detector imports, and what its tests import to run under vitest.",
      license: "Apache-2.0",
      repository: { type: "git", url: "git+https://github.com/passsy/wellactually.git" },
      engines: { node: ">=22.18.0" },
      // No "." on purpose: the detector API version is part of the path.
      exports: Object.fromEntries(
        versions.flatMap((version) => [
          [`./${version}`, { types: `./${version}.d.ts`, default: `./${version}.mjs` }],
          [`./${version}/test`, { types: "./test.d.ts", default: "./test.mjs" }],
        ]),
      ),
      files: ["*.mjs", "*.d.ts", "README.md", "LICENSE"],
      dependencies: { esbuild: esbuildRange },
    },
    null,
    2,
  ),
);

write(
  "README.md",
  `# @wellactually/sdk

What a [Well Actually](https://github.com/passsy/wellactually) principle's detector imports, and what its tests import to run under vitest.

This branch is generated.
The source is in \`packages/sdk\` on the \`main\` branch.
It exists because the SDK is not on npm yet: npm installs the root of a repository, and this is the SDK built, at a root.

## Use it in a repository of principles

\`\`\`bash
npm install --save-dev github:passsy/wellactually#sdk vitest
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
import { onWrite } from "@wellactually/sdk/${newest}";
\`\`\`

A test builds the principle it is in and runs its real detector in the real sandbox.

\`\`\`ts
import { expect, test } from "vitest";
import { detect, write } from "@wellactually/sdk/${newest}/test";

test("fires on a late field", () => {
  expect(detect(write("lib/user.dart", "late String name;"))).toEqual([{ line: 1 }]);
});
\`\`\`

## Versions

This is version ${version}.
The lockfile of your repository pins the commit it installed.
\`npm update @wellactually/sdk\` moves to the newest.
The API is still changing.
That is why the version is part of the import path: \`@wellactually/sdk/${newest}\` and \`@wellactually/sdk/${newest}/test\`.
A principle that imports ${newest} keeps getting the event of ${newest}, also after newer versions exist, and the types under that path stay the types of ${newest}.
This package has ${versions.map((version) => `\`${version}\``).join(" and ")}.
`,
);

write("LICENSE", fs.readFileSync(path.join(root, "LICENSE"), "utf8"));

console.log(`wrote the SDK ${version} to ${target}`);
