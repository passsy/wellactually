import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { API_VERSION } from "@wellactually/sdk";
import { buildBundle } from "@wellactually/core/node";
import { writeCached, writeLockfile } from "../src/board.ts";
import { LOG_MAX_AGE_MS, LOG_MAX_FILE_BYTES, writeHookLog } from "../src/hook-log.ts";

const main = path.resolve(import.meta.dirname, "../src/main.ts");

describe("the hook log", () => {
  test("keeps one file per hour, deletes what is older than a day and stops a full file growing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-log-"));
    const now = new Date("2026-10-16T11:30:00Z");
    const old = path.join(dir, "hooks-2026-10-15T09.jsonl");
    fs.writeFileSync(old, "{}\n");
    fs.utimesSync(old, new Date(now.getTime() - LOG_MAX_AGE_MS - 1000), new Date(now.getTime() - LOG_MAX_AGE_MS - 1000));
    const other = path.join(dir, "sync.log");
    fs.writeFileSync(other, "kept");

    writeHookLog(dir, '{"a":1}', now);
    writeHookLog(dir, '{"a":2}', now);
    expect(fs.readdirSync(dir).sort()).toEqual(["hooks-2026-10-16T11.jsonl", "sync.log"]);
    expect(fs.readFileSync(path.join(dir, "hooks-2026-10-16T11.jsonl"), "utf8")).toBe('{"a":1}\n{"a":2}\n');

    writeHookLog(dir, `"${"x".repeat(LOG_MAX_FILE_BYTES)}"`, now);
    expect(fs.statSync(path.join(dir, "hooks-2026-10-16T11.jsonl")).size).toBeLessThan(100);
  });

  test("records which detectors ran on which event and what they found, after the hook answered", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "wa-hook-"));
    const previous = process.env.WELLACTUALLY_HOME;
    process.env.WELLACTUALLY_HOME = home;
    try {
      const bundle = await buildBundle({ "detector.ts": `import { onPrompt } from "@wellactually/sdk/v3"; onPrompt({ detect: () => [{ match: "enum" }] });` });
      const manifest = { title: "No enums", summary: "Avoid enums.", tags: [], events: ["prompt" as const], globs: [], handlers: [{ event: "prompt" as const, globs: [] }], api: API_VERSION };
      writeCached({ id: "ana/no-enums", version: 4, hash: "a".repeat(64), manifest, advice: "Avoid enums.", bundle });
      writeLockfile({ syncedAt: null, entries: [{ id: "ana/no-enums", version: 4, hash: "a".repeat(64), enabled: true }] });

      const payload = { hook_event_name: "UserPromptSubmit", session_id: "s1", transcript_path: "/t/s1.jsonl", cwd: home, prompt: "add an enum" };
      const out = execFileSync(process.execPath, [main, "hook"], { input: JSON.stringify(payload), env: { ...process.env, WELLACTUALLY_WORKERS: "0" } }).toString();
      expect(out).toContain("ana/no-enums");

      const logs = path.join(home, "logs");
      await vi.waitFor(() => expect(fs.existsSync(logs) && fs.readdirSync(logs).length).toBe(1), { timeout: 5000 });
      const file = path.join(logs, fs.readdirSync(logs)[0] as string);
      await vi.waitFor(() => expect(fs.readFileSync(file, "utf8")).toContain("\n"), { timeout: 5000 });
      const entry = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(entry).toMatchObject({
        hook: "UserPromptSubmit",
        session: "s1",
        transcript: "/t/s1.jsonl",
        events: [{ event: "prompt", text: "add an enum", detectors: [{ id: "ana/no-enums", version: 4, findings: [{ match: "enum" }] }], skipped: [], unmatched: 0 }],
      });
      expect(entry.shown).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) {
        delete process.env.WELLACTUALLY_HOME;
      } else {
        process.env.WELLACTUALLY_HOME = previous;
      }
    }
  });
});
