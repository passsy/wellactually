import { createHash } from "node:crypto";
import { expect, test } from "vitest";

const moduleUrl = new URL("../../../scripts/verify-package.mjs", import.meta.url).href;
const { verifyPublishedPackage } = await import(moduleUrl);
const bytes = Buffer.from("the tested package archive");
const packed = { name: "wellactually", version: "0.11.0-rc.1", integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
const manifest = { ...packed, dist: { integrity: packed.integrity, tarball: "https://registry.npmjs.org/wellactually/-/wellactually-0.11.0-rc.1.tgz" } };

test("a successful upload is not promoted until the registry exposes the exact archive", async () => {
  const responses = [new Response("not ready", { status: 404 }), Response.json(manifest), new Response(bytes)];
  let waits = 0;
  const result = await verifyPublishedPackage(packed, { fetcher: async () => responses.shift()!, sleep: async () => { waits++; }, attempts: 2 });
  expect(result.version).toBe(packed.version);
  expect(waits).toBe(1);
  expect(responses).toHaveLength(0);
});

test("a different public tarball fails verification rather than counting as a release", async () => {
  const responses = [Response.json(manifest), new Response("different bytes")];
  await expect(verifyPublishedPackage(packed, { fetcher: async () => responses.shift()!, attempts: 1 })).rejects.toThrow("tarball differs");
});

test("an accepted upload that stays invisible remains an incomplete release", async () => {
  await expect(verifyPublishedPackage(packed, { fetcher: async () => new Response("not ready", { status: 404 }), attempts: 1 })).rejects.toThrow("do not promote");
});
