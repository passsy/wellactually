import { crc32, inflateSync } from "node:zlib";
import { expect, test } from "vitest";
import { appIcon } from "../../findings/serve/icon.mts";

test("Node 20-compatible icon encoder produces standard PNG checksums and complete RGBA data", () => {
  const image = appIcon(32);
  expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const chunks: string[] = [];
  for (let at = 8; at < image.length;) {
    const length = image.readUInt32BE(at);
    const type = image.toString("ascii", at + 4, at + 8);
    const body = image.subarray(at + 8, at + 8 + length);
    expect(image.readUInt32BE(at + 8 + length)).toBe(crc32(image.subarray(at + 4, at + 8 + length)));
    if (type === "IHDR") expect([body.readUInt32BE(0), body.readUInt32BE(4)]).toEqual([32, 32]);
    if (type === "IDAT") expect(inflateSync(body)).toHaveLength(32 * (32 * 4 + 1));
    chunks.push(type);
    at += length + 12;
  }
  expect(chunks).toEqual(["IHDR", "IDAT", "IEND"]);
});
