import { describe, expect, test } from "vitest";
import { buildPrinciple, bundleTermsOf, checkPrinciple, describeReview, fileCtx, noticesOf, parseSpdx, readLicensing, recognizeLicense, runDetector, vendorPackages, type FileMap, type PackageSource } from "../src/node.ts";

const MIT = [
  "MIT License",
  "",
  "Copyright (c) 2023 Split Contributors",
  "",
  'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction.',
  "",
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.',
].join("\n");
const ISC = [
  "Copyright (c) 2024 the tiny authors",
  "",
  "Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.",
].join("\n");
const APACHE = ["                                 Apache License", "                           Version 2.0, January 2004", "                        http://www.apache.org/licenses/", "", "   Copyright [yyyy] [name of copyright owner]"].join("\n");
const GPL = [
  "                    GNU GENERAL PUBLIC LICENSE",
  "                       Version 3, 29 June 2007",
  "",
  " Copyright (C) 2007 Free Software Foundation, Inc.",
  "",
  "Use with the GNU Affero General Public License.",
  "use the GNU Lesser General Public License instead of this License. /* not the end */",
].join("\n");

describe("a licence expression", () => {
  test("is read with AND, OR and brackets", () => {
    expect(parseSpdx("MIT")).toEqual({ id: "MIT" });
    expect(parseSpdx("(mit OR Apache-2.0)")).toEqual({ any: [{ id: "MIT" }, { id: "Apache-2.0" }] });
    expect(parseSpdx("MIT AND (ISC OR GPL-3.0-only)")).toEqual({ all: [{ id: "MIT" }, { any: [{ id: "ISC" }, { id: "GPL-3.0-only" }] }] });
    expect(parseSpdx("GPL-2.0-only WITH Classpath-exception-2.0")).toEqual({ id: "GPL-2.0-only WITH Classpath-exception-2.0" });
  });

  test("is not one when it is free text", () => {
    for (const text of ["", "SEE LICENSE IN LICENSE.txt", "Apache 2.0", "MIT OR", "(MIT"]) {
      expect(parseSpdx(text)).toBeNull();
    }
  });
});

describe("a licence text", () => {
  test("is recognized by what only that licence says", () => {
    expect(recognizeLicense(MIT)).toEqual(["MIT"]);
    expect(recognizeLicense(ISC)).toEqual(["ISC"]);
    expect(recognizeLicense(APACHE)).toEqual(["Apache-2.0"]);
    expect(recognizeLicense("Redistribution and use in source and binary forms, with or without modification, are permitted provided that")).toEqual(["BSD-2-Clause"]);
    expect(recognizeLicense("Redistribution and use in source and binary forms, with or without modification, are permitted. Neither the name of the authors")).toEqual(["BSD-3-Clause"]);
    expect(recognizeLicense("Do what you like with it.")).toEqual([]);
  });

  test("of a GNU licence is told by its title, not by the other licences it mentions", () => {
    expect(recognizeLicense(GPL)).toEqual(["GPL"]);
    expect(recognizeLicense(`GNU LESSER GENERAL PUBLIC LICENSE\n${GPL}`)).toEqual(["LGPL"]);
  });
});

describe("the licence of a package", () => {
  test("passes by itself when package.json and the licence file say the same", () => {
    expect(readLicensing("MIT", { LICENSE: MIT, NOTICE: "Split\nCopyright 2023 Split Contributors" })).toEqual({
      spdx: "MIT",
      review: "",
      texts: [{ name: "LICENSE", text: MIT }],
      notices: [{ name: "NOTICE", text: "Split\nCopyright 2023 Split Contributors" }],
      copyright: ["Copyright (c) 2023 Split Contributors", "Copyright 2023 Split Contributors"],
    });
  });

  test("is not known without a licence file, or with the text of another licence", () => {
    expect(readLicensing("MIT", {}).review).toBe("its package.json says MIT, and the package has no licence file to show it");
    expect(readLicensing("MIT", { LICENSE: GPL }).review).toBe("its package.json says MIT, and its licence file is the text of GPL");
    expect(readLicensing("MIT", { LICENSE: ISC }).review).toBe("its package.json says MIT, and its licence file is the text of ISC");
    expect(readLicensing("MIT", { LICENSE: "Do what you like with it." }).review).toBe("its package.json says MIT, and its licence file is not the text of that licence");
  });

  test("needs the expert when it is none, not a licence, or not a permissive one", () => {
    expect(readLicensing("", { LICENSE: MIT }).review).toBe("its package.json names no licence");
    expect(readLicensing("UNLICENSED", {})).toMatchObject({ spdx: "UNLICENSED", review: "UNLICENSED is not a licence that passes by itself" });
    expect(readLicensing("SEE LICENSE IN LICENSE.txt", { "LICENSE.txt": MIT })).toMatchObject({ spdx: "", review: 'its package.json says "SEE LICENSE IN LICENSE.txt", which is not the name of a licence' });
    for (const id of ["GPL-3.0-only", "AGPL-3.0-or-later", "LGPL-2.1-only", "MPL-2.0", "EPL-2.0", "BUSL-1.1"]) {
      expect(readLicensing(id, { LICENSE: GPL })).toMatchObject({ spdx: id, review: `${id} is not a licence that passes by itself` });
    }
  });

  test("with OR is taken under the branch that passes, and with AND all have to pass", () => {
    expect(readLicensing("(GPL-3.0-only OR MIT)", { "LICENSE-MIT": MIT, COPYING: GPL })).toMatchObject({ spdx: "MIT", review: "" });
    // Both would pass. The one the package has the text of is the one that is taken.
    expect(readLicensing("MIT OR Apache-2.0", { LICENSE: APACHE })).toMatchObject({ spdx: "Apache-2.0", review: "" });
    expect(readLicensing("MIT AND ISC", { "LICENSE-MIT": MIT, "LICENSE.txt": ISC })).toMatchObject({ spdx: "MIT AND ISC", review: "" });
    expect(readLicensing("MIT AND ISC", { LICENSE: MIT }).review).toBe("its package.json says MIT AND ISC, and its licence file is not the text of that licence");
    expect(readLicensing("MIT AND GPL-3.0-only", { LICENSE: MIT })).toMatchObject({ spdx: "MIT AND GPL-3.0-only", review: "MIT AND GPL-3.0-only is not a licence that passes by itself" });
  });

  test("leaves the form at the end of the Apache licence out of the copyright lines", () => {
    expect(readLicensing("Apache-2.0", { LICENSE: APACHE, NOTICE: "Copyright 2020 The Authors" }).copyright).toEqual(["Copyright 2020 The Authors"]);
  });
});

const principle = ["# Name the port", "", "A port has a name.", "", "A bare number tells a reader nothing about what listens there. Give the port a name and say what it is for."].join("\n");
const detector = `
  import { onWrite } from "@wellactually/sdk/v3";
  import { parse } from "tiny-yaml";
  import { strict } from "copyleft";
  onWrite({
    globs: ["**/*.yaml"],
    *detect(event) {
      if (strict(parse(event.text)).port === "80") {
        yield { line: 1 };
      }
    },
  });`;
const tests = `
  import { expect, test } from "vitest";
  import { detect, write } from "@wellactually/sdk/v3/test";
  import { label } from "only-tests";
  test(label("fires on port 80"), () => {
    expect(detect(write("config.yaml", "port: 80"))).toEqual([{ line: 1 }]);
  });
  test("stays quiet on another port", () => {
    expect(detect(write("config.yaml", "port: 81"))).toEqual([]);
  });`;

const installed: Record<string, FileMap> = {
  "tiny-yaml": {
    "package.json": JSON.stringify({ name: "tiny-yaml", version: "1.2.0", license: "ISC", main: "index.js" }),
    "index.js": `export function parse(text) { return Object.fromEntries(text.split("\\n").filter(Boolean).map((line) => line.split(": "))); }`,
    LICENSE: ISC,
    NOTICE: "tiny-yaml\nCopyright 2024 the tiny authors",
  },
  copyleft: {
    "package.json": JSON.stringify({ name: "copyleft", version: "2.0.1", license: "GPL-3.0-only", main: "index.js" }),
    "index.js": "export function strict(value) { return value; }",
    COPYING: GPL,
  },
  "only-tests": {
    "package.json": JSON.stringify({ name: "only-tests", version: "0.3.0", main: "index.js" }),
    "index.js": "export function label(text) { return text; }",
  },
};
const source: PackageSource = async (name, _version, file) => installed[name]?.[file] ?? null;
const files: FileMap = {
  "principle.md": principle,
  "detector.ts": detector,
  "detector.test.ts": tests,
  "package.json": JSON.stringify({ dependencies: { "tiny-yaml": "1.2.0", copyleft: "^2.0.0", "only-tests": "0.3.0" } }),
};

describe("a bundle with packages", () => {
  test("takes the licence and the NOTICE of each package along", async () => {
    const vendored = await vendorPackages(files, source);
    expect(Object.keys(vendored).filter((name) => /LICENSE|NOTICE|COPYING/.test(name)).sort()).toEqual(["node_modules/copyleft/COPYING", "node_modules/tiny-yaml/LICENSE", "node_modules/tiny-yaml/NOTICE"]);
  });

  test("carries the notices of the packages that are in it, and still runs", async () => {
    const built = await buildPrinciple(await vendorPackages(files, source));
    const notices = noticesOf(built.bundle);
    expect(notices).toContain("tiny-yaml 1.2.0\nLicense: ISC\nSource: https://www.npmjs.com/package/tiny-yaml/v/1.2.0\nCopyright (c) 2024 the tiny authors\nCopyright 2024 the tiny authors\n\nLICENSE:\n\nCopyright (c) 2024 the tiny authors");
    expect(notices).toContain("provided that the above copyright notice and this permission notice appear in all copies.\n\nNOTICE:\n\ntiny-yaml\nCopyright 2024 the tiny authors");
    expect(notices).toContain("copyleft 2.0.1\nLicense: GPL-3.0-only (GPL-3.0-only is not a licence that passes by itself)\nSource: https://www.npmjs.com/package/copyleft/v/2.0.1");
    expect(notices).toContain("GNU GENERAL PUBLIC LICENSE");
    // A licence text cannot end the comment the notices are in.
    expect(notices).toContain("/* not the end * /");
    expect(built.bundle.trimEnd().endsWith("End of third-party notices */")).toBe(true);
    expect((await runDetector(built.bundle, fileCtx("write", "config.yaml", "port: 80"))).findings).toEqual([{ line: 1 }]);
  });

  test("leaves out a package that only the tests import", async () => {
    const built = await buildPrinciple(await vendorPackages(files, source));
    expect(built.manifest.packages?.map((item) => item.name)).toEqual(["copyleft", "tiny-yaml"]);
    expect(noticesOf(built.bundle)).not.toContain("only-tests");
  });

  test("has no notices when the detector uses no package", async () => {
    const plain = await buildPrinciple({ "principle.md": principle, "detector.ts": `import { onWrite } from "@wellactually/sdk/v3"; onWrite({ detect: () => [] });` });
    expect(noticesOf(plain.bundle)).toBe("");
    expect(plain.bundle).not.toContain("Third-party notices");
  });

  test("reports a package whose licence the expert has to approve, without failing the tests", async () => {
    const { built, report } = await checkPrinciple(await vendorPackages(files, source));
    expect(report.ok).toBe(true);
    expect(report.unapproved).toEqual([{ name: "copyleft", version: "2.0.1", license: "GPL-3.0-only", spdx: "GPL-3.0-only", review: "GPL-3.0-only is not a licence that passes by itself" }]);
    expect(built?.manifest.packages?.find((item) => item.name === "tiny-yaml")).toEqual({ name: "tiny-yaml", version: "1.2.0", license: "ISC", spdx: "ISC" });
  });

  test("records an approval for exactly the version that is in the bundle", async () => {
    const vendored = await vendorPackages(files, source);
    const approved = await checkPrinciple(vendored, ["copyleft@2.0.1", "tiny-yaml@1.2.0"]);
    expect(approved.report.unapproved).toEqual([]);
    expect(approved.built?.manifest.packages).toEqual([
      { name: "copyleft", version: "2.0.1", license: "GPL-3.0-only", spdx: "GPL-3.0-only", review: "GPL-3.0-only is not a licence that passes by itself", approved: true },
      // It needed no approval, so none is recorded for it.
      { name: "tiny-yaml", version: "1.2.0", license: "ISC", spdx: "ISC" },
    ]);
    for (const other of ["copyleft@2.0.0", "copyleft", "other@2.0.1"]) {
      expect((await checkPrinciple(vendored, [other])).report.unapproved.map((item) => item.name)).toEqual(["copyleft"]);
    }
  });

  test("says that the GPL and the AGPL put the whole bundle under their terms, and says it of no other licence", async () => {
    const built = await buildPrinciple(await vendorPackages(files, source));
    const copyleft = built.manifest.packages?.find((item) => item.name === "copyleft") ?? { name: "", version: "", license: "" };
    expect(bundleTermsOf(copyleft)).toBe("GPL-3.0-only");
    expect(describeReview(copyleft)).toBe("GPL-3.0-only is not a licence that passes by itself. With it in the detector, the whole detector bundle is distributed under the terms of GPL-3.0-only");
    for (const spdx of ["AGPL-3.0-or-later", "MIT AND GPL-2.0-only"]) {
      expect(bundleTermsOf({ name: "x", version: "1.0.0", license: spdx, spdx })).toBe(spdx.replace("MIT AND ", ""));
    }
    for (const spdx of ["MIT", "LGPL-2.1-only", "MPL-2.0", "EPL-2.0", "UNLICENSED"]) {
      expect(bundleTermsOf({ name: "x", version: "1.0.0", license: spdx, spdx })).toBeNull();
    }
    expect(describeReview({ name: "x", version: "1.0.0", license: "", review: "its package.json names no licence" })).toBe("its package.json names no licence");
  });

  test("says of the LGPL what it asks of the library, not of the whole bundle", () => {
    const review = "LGPL-2.1-only is not a licence that passes by itself";
    expect(describeReview({ name: "x", version: "1.0.0", license: "LGPL-2.1-only", spdx: "LGPL-2.1-only", review })).toBe(
      `${review}. The part under LGPL-2.1-only has to stay replaceable by whoever uses the detector, and its source has to be available. The notices in the bundle link to it`,
    );
  });

  test("names a package from a repository by its commit, in the approval and in the notices", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const kit: FileMap = {
      "package.json": JSON.stringify({ name: "copyleft", main: "index.js" }),
      "index.js": "export function strict(value) { return value; }",
      ".wellactually-from": `github:passsy/copyleft#${commit}`,
    };
    const fromRepository: PackageSource = async (name, version, file) => {
      if (name === "copyleft") {
        return kit[file] ?? null;
      }
      return source(name, version, file);
    };
    const uses = { ...files, "package.json": JSON.stringify({ dependencies: { "tiny-yaml": "1.2.0", copyleft: "github:passsy/copyleft", "only-tests": "0.3.0" } }) };
    const vendored = await vendorPackages(uses, fromRepository);
    expect((await checkPrinciple(vendored)).report.unapproved).toEqual([{ name: "copyleft", version: "", license: "", from: `github:passsy/copyleft#${commit}`, review: "its package.json names no licence" }]);
    const approved = await checkPrinciple(vendored, [`copyleft@github:passsy/copyleft#${commit}`]);
    expect(approved.report.unapproved).toEqual([]);
    expect(noticesOf(approved.built?.bundle ?? "")).toContain(`copyleft\nLicense: unknown (its package.json names no licence)\nSource: https://github.com/passsy/copyleft/tree/${commit}\n\nThe package has no licence file.`);
  });
});
