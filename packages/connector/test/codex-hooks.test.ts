import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { askCodexHooksNeedReview, codexHooksSilent, noteCodexHook, noteCodexServer } from "../../board/src/codex-hooks.ts";
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

test("an install whose hooks Codex said need review is silent, until a hook runs", () => {
  const root = install("0.12.0");
  expect(codexHooksSilent(root)).toBe(false);
  noteCodexServer(root, true);
  expect(codexHooksSilent(root)).toBe(true);
  expect(codexHooksSilent()).toBe(true);
  noteCodexHook(root);
  expect(codexHooksSilent(root)).toBe(false);
  noteCodexServer(root, true);
  expect(codexHooksSilent()).toBe(false);
});

test("an install whose hooks Codex trusts, or could not answer for, is not silent before its first hook", () => {
  const trusted = install("0.12.0");
  noteCodexServer(trusted, false);
  expect(codexHooksSilent(trusted)).toBe(false);
  const unknown = install("0.13.0");
  noteCodexServer(unknown, undefined);
  expect(codexHooksSilent(unknown)).toBe(false);
});

test("an update is a new install that has to prove its hooks again, and the old one drops out", () => {
  const old = install("0.12.0");
  noteCodexServer(old, true, new Date("2026-11-17T10:00:00Z"));
  noteCodexHook(old);
  const next = install("0.13.0");
  noteCodexServer(next, true, new Date("2026-11-18T10:00:00Z"));
  expect(codexHooksSilent()).toBe(true);
  fs.rmSync(old, { recursive: true });
  noteCodexHook(next);
  expect(Object.keys(JSON.parse(fs.readFileSync(path.join(process.env.WELLACTUALLY_HOME!, "codex-hooks.json"), "utf8")))).toEqual([fs.realpathSync(next)]);
  expect(codexHooksSilent()).toBe(false);
});

test("a Codex hook call records that it ran from its install", async () => {
  const root = install("0.12.0");
  noteCodexServer(root, true);
  process.env.PLUGIN_ROOT = root;
  await runHook(JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s" }));
  expect(codexHooksSilent(root)).toBe(false);
});

/** A stand-in for `codex app-server` that lists the given trust status for our hooks and someone else's. */
function fakeCodex(status: string): string {
  const bin = path.join(cache, "codex");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const hooks = [{ pluginId: "wellactually@wellactually", enabled: true, trustStatus: ${JSON.stringify(status)} }, { pluginId: "other@x", enabled: true, trustStatus: "untrusted" }];
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
  if (m.id === 2) console.log(JSON.stringify({ id: 2, result: { data: [{ cwd: m.params.cwds[0], hooks }] } }));
});
`, { mode: 0o755 });
  return bin;
}

test.skipIf(process.platform === "win32")("Codex's hooks/list answers whether our hooks need review", async () => {
  expect(await askCodexHooksNeedReview(cache, { bin: fakeCodex("untrusted"), args: "codex" })).toBe(true);
  expect(await askCodexHooksNeedReview(cache, { bin: fakeCodex("modified"), args: "codex" })).toBe(true);
  expect(await askCodexHooksNeedReview(cache, { bin: fakeCodex("trusted"), args: "codex" })).toBe(false);
  expect(await askCodexHooksNeedReview(cache, { bin: fakeCodex("untrusted"), args: "codex exec --dangerously-bypass-hook-trust" })).toBe(false);
  expect(await askCodexHooksNeedReview(cache, { bin: path.join(cache, "missing"), args: "codex" })).toBe(undefined);
  expect(await askCodexHooksNeedReview(cache, null)).toBe(undefined);
});
