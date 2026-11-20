import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { codexHooksSilent, noteCodexHook, noteCodexServer } from "../../board/src/codex-hooks.ts";
import { runHook } from "../src/hook/hook.ts";

const saved = { ...process.env };
let cache: string;

beforeEach(() => {
  process.env.WELLACTUALLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wa-codex-hooks-"));
  cache = fs.mkdtempSync(path.join(os.tmpdir(), "wa-codex-cache-"));
  delete process.env.PLUGIN_ROOT;
});
afterEach(() => {
  process.env = { ...saved };
});

function install(version: string): string {
  const root = path.join(cache, version);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

test("an install whose server started but whose hooks never ran is silent, until a hook runs", () => {
  const root = install("0.12.0");
  expect(codexHooksSilent(root)).toBe(false);
  noteCodexServer(root);
  expect(codexHooksSilent(root)).toBe(true);
  expect(codexHooksSilent()).toBe(true);
  noteCodexHook(root);
  expect(codexHooksSilent(root)).toBe(false);
  noteCodexServer(root);
  expect(codexHooksSilent()).toBe(false);
});

test("an update is a new install that has to prove its hooks again, and the old one drops out", () => {
  const old = install("0.12.0");
  noteCodexServer(old, new Date("2026-11-17T10:00:00Z"));
  noteCodexHook(old);
  const next = install("0.13.0");
  noteCodexServer(next, new Date("2026-11-18T10:00:00Z"));
  expect(codexHooksSilent()).toBe(true);
  fs.rmSync(old, { recursive: true });
  noteCodexHook(next);
  expect(Object.keys(JSON.parse(fs.readFileSync(path.join(process.env.WELLACTUALLY_HOME!, "codex-hooks.json"), "utf8")))).toEqual([fs.realpathSync(next)]);
  expect(codexHooksSilent()).toBe(false);
});

test("a Codex hook call records that it ran from its install", async () => {
  const root = install("0.12.0");
  noteCodexServer(root);
  process.env.PLUGIN_ROOT = root;
  await runHook(JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s" }));
  expect(codexHooksSilent(root)).toBe(false);
});
