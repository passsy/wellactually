import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { claimReport, drainDetections, recordDetections, type DetectionCount } from "../src/board/detections.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);

beforeEach(() => {
  process.env.WELLACTUALLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "board-detections-"));
});

describe("the detection log", () => {
  test("counts each principle per day and forgets what was sent", async () => {
    recordDetections([A, B], new Date("2026-10-07T10:00:00Z"));
    recordDetections([A], new Date("2026-10-07T11:00:00Z"));
    recordDetections([A], new Date("2026-10-08T10:00:00Z"));

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
    recordDetections([A], new Date("2026-10-07T10:00:00Z"));
    await expect(
      drainDetections(async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");

    recordDetections([A], new Date("2026-10-07T11:00:00Z"));
    let sent: DetectionCount[] = [];
    await drainDetections(async (counts) => {
      sent = counts;
    });
    expect(sent).toEqual([{ day: "2026-10-07", hash: A, count: 2 }]);
  });

  test("counts a principle at most ten times in any ten minutes", async () => {
    for (let second = 0; second < 12; second++) {
      recordDetections([A, B], new Date(Date.UTC(2026, 9, 7, 10, 0, second)));
    }
    recordDetections([A], new Date("2026-10-07T10:09:59Z"));
    // The first ones are ten minutes old, so there is room again.
    recordDetections([A], new Date("2026-10-07T10:10:01Z"));
    recordDetections([A], new Date("2026-10-07T10:10:02Z"));

    let sent: DetectionCount[] = [];
    await drainDetections(async (counts) => {
      sent = counts;
    });
    expect(sent).toEqual([
      { day: "2026-10-07", hash: A, count: 12 },
      { day: "2026-10-07", hash: B, count: 10 },
    ]);
  });

  test("sends nothing when nothing fired", async () => {
    let called = false;
    await drainDetections(async () => {
      called = true;
    });
    expect(called).toBe(false);
  });

  test("sends at most every five minutes", () => {
    expect(claimReport(new Date("2026-10-07T10:00:00Z"))).toBe(true);
    expect(claimReport(new Date("2026-10-07T10:04:59Z"))).toBe(false);
    expect(claimReport(new Date("2026-10-07T10:05:00Z"))).toBe(true);
    expect(claimReport(new Date("2026-10-07T10:06:00Z"))).toBe(false);
  });
});
