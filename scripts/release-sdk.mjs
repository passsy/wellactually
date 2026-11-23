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
const coreDependencies = JSON.parse(fs.readFileSync(path.join(root, "packages/core/package.json"), "utf8")).dependencies;
const esbuildRange = coreDependencies.esbuild;
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
// The host: what builds, checks and runs principles outside a principle's own tests, such as the registry.
// `host` runs anywhere, also in a browser, so it carries no require banner. `host/node` adds the native
// engines and the disk. One build with shared chunks, so both entries share one module state: the
// engines `host/node` sets are the ones `host` uses.
await bundle({
  ...shared,
  banner: {},
  entryPoints: { host: path.join(root, "packages/core/src/index.ts"), "host-node": path.join(root, "packages/core/src/node.ts") },
  outdir: target,
  splitting: true,
  chunkNames: "host-chunks/[name]-[hash]",
  outExtension: { ".js": ".mjs" },
});

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

// The host's types, as the tree of declarations tsc writes, with the SDK it imports by name pointed at its own copy.
const hostTypes = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-host-types-"));
try {
  execFileSync(
    path.join(root, "node_modules/.bin/tsc"),
    ["--strict", "--declaration", "--emitDeclarationOnly", "--allowImportingTsExtensions", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2023", "--skipLibCheck", "--types", "node", "--rootDir", path.join(root, "packages"), "--outDir", hostTypes, path.join(root, "packages/detector-sdk/src/index.ts"), path.join(root, "packages/core/src/index.ts"), path.join(root, "packages/core/src/node.ts")],
    { stdio: "pipe" },
  );
  const out = path.join(target, "host-types");
  fs.cpSync(hostTypes, out, { recursive: true });
  const sdkIndex = path.join(out, "detector-sdk/src/index.js");
  for (const file of fs.readdirSync(out, { recursive: true }).map((name) => path.join(out, name)).filter((name) => name.endsWith(".d.ts"))) {
    let relative = path.relative(path.dirname(file), sdkIndex).replaceAll("\\", "/");
    relative = relative.startsWith(".") ? relative : `./${relative}`;
    const text = fs.readFileSync(file, "utf8").replace(/(from\s+["']\.{1,2}\/[^"']+)\.ts(["'])/g, "$1.js$2").replace(/(["'])@wellactually\/detector-sdk\1/g, `$1${relative}$1`);
    fs.writeFileSync(file, text);
  }
} finally {
  fs.rmSync(hostTypes, { recursive: true, force: true });
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
      exports: {
        ...Object.fromEntries(
          versions.flatMap((version) => [
            [`./${version}`, { types: `./${version}.d.ts`, default: `./${version}.mjs` }],
            [`./${version}/test`, { types: "./test.d.ts", default: "./test.mjs" }],
          ]),
        ),
        "./host": { types: "./host-types/core/src/index.d.ts", default: "./host.mjs" },
        "./host/node": { types: "./host-types/core/src/node.d.ts", default: "./host-node.mjs" },
      },
      files: ["*.mjs", "*.d.ts", "host-chunks", "host-types", "README.md", "PUBLISHING.md", "LICENSE", "THIRD_PARTY_NOTICES.txt"],
      // The isolate's code is bundled. Its types are not: the host's declarations name a QuickJS module.
      dependencies: { esbuild: esbuildRange, "quickjs-emscripten-core": coreDependencies["quickjs-emscripten-core"] },
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

## Hosts

\`@wellactually/detector-sdk/host\` builds, checks and runs principles: the isolate, the bundler, the test runner and the licence checks.
It runs anywhere, also in a browser, where the bundler and the isolate are handed in with \`setEngines\`.
\`@wellactually/detector-sdk/host/node\` sets the native engines and adds what needs a disk.
The Well Actually registry runs principles with them.
`,
);

write("PUBLISHING.md", fs.readFileSync(path.join(root, "packages/detector-sdk/PUBLISHING.md"), "utf8")
  .replaceAll("../connector/PUBLISHING.md", "https://github.com/passsy/wellactually/blob/main/packages/connector/PUBLISHING.md"));
write("THIRD_PARTY_NOTICES.txt", bundleNotices(metafiles, root));
write("LICENSE", fs.readFileSync(path.join(root, "LICENSE"), "utf8"));

const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", artifacts], { cwd: target, encoding: "utf8" }))[0];
fs.writeFileSync(path.join(artifacts, "pack.json"), JSON.stringify(packed, null, 2) + "\n");
console.log(`Packed ${packed.name}@${packed.version} at ${path.join(artifacts, packed.filename)}`);
