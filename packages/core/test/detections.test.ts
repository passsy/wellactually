import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { drainDetections, recordDetections, type DetectionCount } from "../src/node.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);

beforeEach(() => {
  process.env.WELLACTUALLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "board-detections-"));
});

describe("the detection log", () => {
  test("counts each principle per day and forgets what was sent", async () => {
    recordDetections([A, B], "2026-10-07");
    recordDetections([A], "2026-10-07");
    recordDetections([A], "2026-10-08");

    let sent: DetectionCount[] = [];
    const total = await drainDetections(async (counts) => {
      sent = counts;
    });

    expect(total).toBe(4);
    expect(sent).toEqual([
      { day: "2026-10-07", hash: A, count: 2 },
      { day: "2026-10-07", hash: B, count: 1 },
      { day: "2026-10-08", hash: A, count: 1 },
    ]);
    expect(await drainDetections(async () => {})).toBe(0);
  });

  test("keeps what could not be sent and sends it with the next call", async () => {
    recordDetections([A], "2026-10-07");
    await expect(
      drainDetections(async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");

    recordDetections([A], "2026-10-07");
    let sent: DetectionCount[] = [];
    await drainDetections(async (counts) => {
      sent = counts;
    });
    expect(sent).toEqual([{ day: "2026-10-07", hash: A, count: 2 }]);
  });

  test("sends nothing when nothing fired", async () => {
    let called = false;
    await drainDetections(async () => {
      called = true;
    });
    expect(called).toBe(false);
  });
});
