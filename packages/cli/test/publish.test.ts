import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { scaffoldFiles, type PackageInfo } from "@wellactually/core/node";
import { writePrincipleFiles } from "../src/board/files.ts";
import { ApprovalError, publishPrinciple } from "../src/commands.ts";

/** A principle on disk whose detector imports a package under the GPL, installed next to it. */
function principleWithCopyleft(): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wa-publish-")), "name-the-port");
  const files = scaffoldFiles("name-the-port");
  writePrincipleFiles(dir, {
    ...files,
    "detector.ts": `import { strict } from "copyleft";\nstrict("loaded");\n${files["detector.ts"] ?? ""}`,
    "package.json": JSON.stringify({ dependencies: { copyleft: "2.0.1" } }),
    "node_modules/copyleft/package.json": JSON.stringify({ name: "copyleft", version: "2.0.1", license: "GPL-3.0-only", main: "index.js" }),
    "node_modules/copyleft/index.js": "export function strict(value) { return value; }",
    "node_modules/copyleft/COPYING": "GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007",
  });
  return dir;
}

describe("publishing a principle with a package the expert has to approve", () => {
  test("uploads nothing where nobody can be asked, and says which flag approves it", async () => {
    const dir = principleWithCopyleft();
    const refused = publishPrinciple(dir);
    await expect(refused).rejects.toThrow(ApprovalError);
    await expect(refused).rejects.toThrow("copyleft@2.0.1: GPL-3.0-only is not a licence that passes by itself. With it in the detector, the whole detector bundle is distributed under the terms of GPL-3.0-only");
    await expect(refused).rejects.toThrow(`wellactually publish ${dir} --approve copyleft@2.0.1`);
    // The approval of another version is not one for this version.
    await expect(publishPrinciple(dir, { approved: ["copyleft@2.0.0"] })).rejects.toThrow(ApprovalError);
  });

  test("asks about each such package, and a no stops it", async () => {
    const asked: PackageInfo[] = [];
    const refused = publishPrinciple(principleWithCopyleft(), {
      confirm: async (info) => {
        asked.push(info);
        return false;
      },
    });
    await expect(refused).rejects.toThrow(ApprovalError);
    expect(asked.map((info) => `${info.name} ${info.version} ${info.spdx}`)).toEqual(["copyleft 2.0.1 GPL-3.0-only"]);
  });
});
