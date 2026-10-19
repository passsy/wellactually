import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runHook } from "../src/hook/hook.ts";
import { agentOf, checkForUpdate, isNewer, LATEST_URL, updateNotice } from "../src/update.ts";

const NOW = Date.parse("2026-10-19T10:00:00Z");
const HOUR = 60 * 60 * 1000;
const saved = { ...process.env };

beforeEach(() => {
  process.env.WELLACTUALLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wa-update-"));
  delete process.env.CI;
  delete process.env.NO_UPDATE_NOTIFIER;
  delete process.env.WELLACTUALLY_UPDATE_CHECK;
  delete process.env.WELLACTUALLY_BRIDGED;
  delete process.env.PLUGIN_ROOT;
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...saved };
});

function found(latest: string, checkedAt = NOW): void {
  fs.writeFileSync(path.join(process.env.WELLACTUALLY_HOME!, "update.json"), JSON.stringify({ latest, checkedAt: new Date(checkedAt).toISOString() }));
}

test("a later release is newer, an equal or earlier one is not", () => {
  expect(isNewer("0.9.29", "0.9.28")).toBe(true);
  expect(isNewer("0.10.0", "0.9.28")).toBe(true);
  expect(isNewer("1.0.0", "0.9.28")).toBe(true);
  expect(isNewer("0.9.28", "0.9.28")).toBe(false);
  expect(isNewer("0.9.9", "0.9.28")).toBe(false);
  expect(isNewer("garbage", "0.9.28")).toBe(false);
});

test("Codex is told apart from Claude Code by the plugin root it sets", () => {
  expect(agentOf({ PLUGIN_ROOT: "/x" })).toBe("codex");
  expect(agentOf({ CLAUDE_PLUGIN_ROOT: "/x" })).toBe("claude-code");
});

test("a newer release is announced with the agent's update command, then not again that day", () => {
  found("0.9.30");
  const first = updateNotice("codex", NOW, "0.9.28");
  expect(first.text).toBe("Well Actually 0.9.30 is available, you have 0.9.28. To update, run `codex plugin marketplace upgrade wellactually` and restart Codex.");
  expect(updateNotice("codex", NOW + HOUR, "0.9.28").text).toBe("");
  expect(updateNotice("codex", NOW + 25 * HOUR, "0.9.28").text).toContain("0.9.30 is available");
});

test("the next release is announced even on the day the last one was", () => {
  found("0.9.30");
  updateNotice("pi", NOW, "0.9.28");
  found("0.9.31");
  expect(updateNotice("pi", NOW + HOUR, "0.9.28").text).toContain("0.9.31 is available");
});

test("nothing is announced when the plugin is current", () => {
  found("0.9.28");
  expect(updateNotice("claude-code", NOW, "0.9.28")).toEqual({ text: "", stale: false });
});

test("a check is due when there was none or the last is a day old", () => {
  expect(updateNotice("claude-code", NOW, "0.9.28").stale).toBe(true);
  found("0.9.28", NOW - 25 * HOUR);
  expect(updateNotice("claude-code", NOW, "0.9.28").stale).toBe(true);
});

test("CI, NO_UPDATE_NOTIFIER and WELLACTUALLY_UPDATE_CHECK=0 switch it off", () => {
  found("9.0.0", NOW - 25 * HOUR);
  for (const [key, value] of [["CI", "true"], ["NO_UPDATE_NOTIFIER", "1"], ["WELLACTUALLY_UPDATE_CHECK", "0"]] as const) {
    process.env[key] = value;
    expect(updateNotice("claude-code", NOW)).toEqual({ text: "", stale: false });
    delete process.env[key];
  }
});

test("a check remembers the version on GitHub", async () => {
  const fetch = vi.fn(async () => Response.json({ name: "wellactually", version: "0.9.30" }));
  vi.stubGlobal("fetch", fetch);
  expect(await checkForUpdate(NOW)).toBe("0.9.30");
  expect(fetch).toHaveBeenCalledWith(LATEST_URL, expect.anything());
  expect(updateNotice("opencode", NOW + HOUR, "0.9.28")).toEqual({
    text: "Well Actually 0.9.30 is available, you have 0.9.28. To update, run `opencode plugin update` and restart OpenCode.",
    stale: false,
  });
});

test("a failed check keeps what the last one found and waits a day", async () => {
  found("0.9.30", NOW - 25 * HOUR);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("fetch failed");
    }),
  );
  expect(await checkForUpdate(NOW)).toBe("0.9.30");
  expect(updateNotice("claude-code", NOW + HOUR, "0.9.28").stale).toBe(false);
});

test("session start shows the notice to the user in Claude Code, not to the agent", async () => {
  found("99.0.0");
  const out = JSON.parse(await runHook(JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1", cwd: os.tmpdir() })));
  expect(out.hookSpecificOutput).toBeUndefined();
  expect(out.systemMessage).toContain("Well Actually 99.0.0 is available");
  expect(out.systemMessage).toContain("claude plugin marketplace update wellactually` and `claude plugin update wellactually@wellactually");
});

test("session start leaves the notice to the OpenCode and pi plugins", async () => {
  found("99.0.0");
  process.env.WELLACTUALLY_BRIDGED = "1";
  expect(await runHook(JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1", cwd: os.tmpdir() }))).toBe("");
});

test("OpenCode 1 users pull the clone the plugin runs from", () => {
  found("0.9.30");
  expect(updateNotice("opencode-1", NOW, "0.9.28", "/Users/me/wellactually/opencode").text).toBe(
    "Well Actually 0.9.30 is available, you have 0.9.28. To update, run `git pull` in /Users/me/wellactually/opencode and restart OpenCode.",
  );
});
