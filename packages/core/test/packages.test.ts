import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildPrinciple, checkPrinciple, fileCtx, keptPackages, parseGitHub, readPrinciple, runDetector, vendorPackages, type PrincipleFiles, type PackageSource } from "../src/node.ts";

const principle = ["# Name the port", "", "A port has a name.", "", "A bare number tells a reader nothing about what listens there. Give the port a name and say what it is for."].join("\n");
const detector = `
  import { onWrite } from "@wellactually/sdk/v3";
  import { parse } from "tiny-yaml";
  onWrite({
    globs: ["**/*.yaml"],
    *detect(event) {
      if (parse(event.text).port === "80") {
        yield { line: 1 };
      }
    },
  });`;
const ISC = [
  "ISC License",
  "",
  "Copyright (c) 2024 the tiny authors",
  "",
  "Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.",
  "",
  'THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE.',
].join("\n");
const MIT = [
  "MIT License",
  "",
  "Copyright (c) 2023 Split Contributors",
  "",
  'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction.',
  "",
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.',
].join("\n");
const pins = JSON.stringify({ dependencies: { "tiny-yaml": "1.2.0" } });

/** What is installed: a package with an entry, a file it imports and a package it depends on. */
const installed: Record<string, PrincipleFiles> = {
  "tiny-yaml": {
    "package.json": JSON.stringify({ name: "tiny-yaml", version: "1.2.0", license: "ISC", exports: { ".": { node: "./node.js", default: "./dist/index.js" } }, dependencies: { "@tiny/split": "^3.0.0" } }),
    "dist/index.js": `import { pairs } from "./pairs.js";\nexport function parse(text) { return Object.fromEntries(pairs(text)); }`,
    "dist/pairs.js": `import split from "@tiny/split";\nexport function pairs(text) { return text.split("\\n").filter(Boolean).map((line) => split(line, ": ")); }`,
    "node.js": `import fs from "node:child_process";\nexport const parse = fs;`,
    "docs/unused.js": "export const unused = 1;",
    LICENSE: ISC,
  },
  "@tiny/split": {
    "package.json": JSON.stringify({ name: "@tiny/split", version: "3.1.4", license: "MIT", main: "index.cjs" }),
    "index.cjs": `module.exports = function split(text, by) { return text.split(by); };`,
    "LICENSE.md": MIT,
  },
};
const source: PackageSource = async (name, _version, file) => installed[name]?.[file] ?? null;
const files: PrincipleFiles = { "principle.md": principle, "detector.ts": detector, "package.json": pins };

describe("a package from npm", () => {
  test("travels with the principle: the files the detector reaches, its package.json and its licence", async () => {
    const vendored = await vendorPackages(files, source);
    expect(Object.keys(vendored).filter((name) => name.startsWith("node_modules/")).sort()).toEqual([
      "node_modules/@tiny/split/LICENSE.md",
      "node_modules/@tiny/split/index.cjs",
      "node_modules/@tiny/split/package.json",
      "node_modules/tiny-yaml/LICENSE",
      "node_modules/tiny-yaml/dist/index.js",
      "node_modules/tiny-yaml/dist/pairs.js",
      "node_modules/tiny-yaml/package.json",
    ]);
  });

  test("is built from the files alone afterwards, and runs in the isolate", async () => {
    const built = await buildPrinciple(await vendorPackages(files, source));
    expect(built.manifest.packages).toEqual([
      { name: "@tiny/split", version: "3.1.4", license: "MIT", spdx: "MIT" },
      { name: "tiny-yaml", version: "1.2.0", license: "ISC", spdx: "ISC" },
    ]);
    expect((await runDetector(built.bundle, fileCtx("write", "config.yaml", "port: 80\nhost: a"))).findings).toEqual([{ line: 1 }]);
    expect((await runDetector(built.bundle, fileCtx("write", "config.yaml", "port: 81"))).findings).toEqual([]);
  });

  test("a principle without packages has none in its manifest", async () => {
    const plain = await buildPrinciple({ "principle.md": principle, "detector.ts": `import { onWrite } from "@wellactually/sdk/v3"; onWrite({ detect: () => [] });` });
    expect(plain.manifest.packages).toBeUndefined();
  });

  test("a range is settled when the principle is submitted, to the version that is there", async () => {
    const ranged = { ...files, "package.json": JSON.stringify({ dependencies: { "tiny-yaml": "^1.1.0" } }) };
    const built = await buildPrinciple(await vendorPackages(ranged, source));
    expect(built.manifest.packages?.find((item) => item.name === "tiny-yaml")?.version).toBe("1.2.0");
    for (const stale of ["^1.3.0", "^2.0.0", "~1.1.0", "^0.2.0"]) {
      await expect(vendorPackages({ ...files, "package.json": JSON.stringify({ dependencies: { "tiny-yaml": stale } }) }, source)).rejects.toThrow(/asks for tiny-yaml .* and 1.2.0 is installed/);
    }
  });

  test("needs its package in the package.json of the principle, at a version from npm", async () => {
    const report = async (extra: PrincipleFiles) => (await checkPrinciple({ ...files, ...extra })).report.problems[0];
    expect(await report({ "package.json": JSON.stringify({ dependencies: { "tiny-yaml": "file:../tiny-yaml" } }) })).toMatch(/has to name a version of tiny-yaml from npm/);
    const { "package.json": _, ...unpinned } = files;
    expect((await checkPrinciple(unpinned)).report.problems[0]).toMatch(/"tiny-yaml" cannot be imported.*packages its package.json names/);
    await expect(vendorPackages({ ...files, "package.json": JSON.stringify({ dependencies: { other: "1.0.0" } }) }, source)).rejects.toThrow(/"tiny-yaml" is not in the package.json of the principle/);
  });

  test("is refused when another version is installed, or none", async () => {
    await expect(vendorPackages({ ...files, "package.json": JSON.stringify({ dependencies: { "tiny-yaml": "1.3.0" } }) }, source)).rejects.toThrow(/asks for tiny-yaml 1.3.0, and 1.2.0 is installed/);
    await expect(vendorPackages(files, async () => null)).rejects.toThrow(/"tiny-yaml" is in package.json but not installed/);
  });

  test("can come from a repository, in TypeScript, and records the commit it was taken at", async () => {
    const kit: PrincipleFiles = {
      "package.json": JSON.stringify({ name: "dart-kit", license: "MIT", exports: "./src/index.ts" }),
      LICENSE: MIT,
      "src/index.ts": `import { strip } from "./strip";\nexport function parse(text: string): Record<string, string> { return { port: strip(text) }; }`,
      "src/strip.ts": `export const strip = (text: string): string => text.replace("port: ", "");`,
      ".wellactually-from": "github:passsy/dart-kit#0123456789abcdef0123456789abcdef01234567",
    };
    const fromRepository: PackageSource = async (name, version, file) => {
      expect(version).toBe("github:passsy/dart-kit#main");
      return kit[file] ?? null;
    };
    const uses = { ...files, "detector.ts": detector.replace('"tiny-yaml"', '"dart-kit"'), "package.json": JSON.stringify({ dependencies: { "dart-kit": "github:passsy/dart-kit#main" } }) };
    const built = await buildPrinciple(await vendorPackages(uses, fromRepository));
    expect(built.manifest.packages).toEqual([{ name: "dart-kit", version: "", license: "MIT", from: "github:passsy/dart-kit#0123456789abcdef0123456789abcdef01234567", spdx: "MIT" }]);
    expect((await runDetector(built.bundle, fileCtx("write", "config.yaml", "port: 80"))).findings).toEqual([{ line: 1 }]);
  });

  test("from the principle's own repository is kept as it came, and never asked for elsewhere", async () => {
    // What reading the repository left: the package next to the principles, marked with where it was taken from.
    const local: PackageSource = async (name, _version, file) => {
      if (name !== "tiny-yaml") {
        return installed[name]?.[file] ?? null;
      }
      if (file === ".wellactually-from") {
        return "github:ana/principles#abc1234";
      }
      return installed[name]?.[file] ?? null;
    };
    const synced = await vendorPackages({ ...files, "package.json": JSON.stringify({ dependencies: { "tiny-yaml": "*" } }) }, local);
    expect(synced["node_modules/tiny-yaml/.wellactually-from"]).toBe("github:ana/principles#abc1234");

    // The editor has no repository at hand. Somebody published another tiny-yaml where it looks for packages.
    const asked: string[] = [];
    const elsewhere: PackageSource = async (name, _version, file) => {
      asked.push(name);
      if (name === "tiny-yaml") {
        return file === "package.json" ? JSON.stringify({ name: "tiny-yaml", version: "9.9.9", main: "evil.js" }) : "export const parse = () => ({});";
      }
      return installed[name]?.[file] ?? null;
    };
    const own: PrincipleFiles = {};
    for (const [name, content] of Object.entries(synced)) {
      if (!name.startsWith("node_modules/")) {
        own[name] = content;
      }
    }
    const again = await vendorPackages(own, keptPackages(synced, elsewhere));
    expect(again).toEqual(synced);
    expect(asked.includes("tiny-yaml")).toBe(false);
    const built = await buildPrinciple(again);
    expect((await runDetector(built.bundle, fileCtx("write", "config.yaml", "port: 80"))).findings).toEqual([{ line: 1 }]);

    // Without what it came with, the package is not there: the name alone finds the stranger's.
    await expect(vendorPackages(own, keptPackages(own, elsewhere))).resolves.not.toEqual(synced);
  });

  test("knows a repository on GitHub in the spellings npm takes", () => {
    const main = { owner: "passsy", repo: "dart-kit", ref: "main" };
    expect(parseGitHub("github:passsy/dart-kit#main")).toEqual(main);
    expect(parseGitHub("passsy/dart-kit#main")).toEqual(main);
    expect(parseGitHub("git+https://github.com/passsy/dart-kit.git#main")).toEqual(main);
    expect(parseGitHub("git+ssh://git@github.com/passsy/dart-kit.git#main")).toEqual(main);
    expect(parseGitHub("github:passsy/dart-kit")).toEqual({ ...main, ref: null });
    expect(parseGitHub("^2.9.1")).toBeNull();
  });

  test("cannot bring Node with it", async () => {
    const node: PackageSource = async (name, version, file) => {
      if (name === "tiny-yaml" && file === "package.json") {
        return JSON.stringify({ name: "tiny-yaml", version: "1.2.0", main: "node.js" });
      }
      return source(name, version, file);
    };
    await expect(vendorPackages(files, node)).rejects.toThrow(/"node:child_process" cannot be imported. The package tiny-yaml runs in an isolate without Node/);
  });

  test("is read from node_modules of the folder or of one above it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-packages-"));
    const dir = path.join(root, "principles", "name-the-port");
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), content);
    }
    for (const [name, pack] of Object.entries(installed)) {
      for (const [file, content] of Object.entries(pack)) {
        const full = path.join(root, "node_modules", name, file);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
      }
    }
    const read = await readPrinciple(dir);
    expect(read["node_modules/tiny-yaml/dist/index.js"]).toContain("export function parse");
    expect(read["node_modules/tiny-yaml/docs/unused.js"]).toBeUndefined();
    expect((await checkPrinciple(read)).built?.manifest.packages?.map((item) => item.name)).toEqual(["@tiny/split", "tiny-yaml"]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
