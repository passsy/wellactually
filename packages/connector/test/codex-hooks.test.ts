import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, expect, test } from "vitest";
import { codexHookTrust, hookStates, pluginContentHash } from "../src/codex-hooks.ts";

let home: string;
let root: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "wa-codex-hooks-"));
  root = path.join(home, "plugins", "cache", "market", "wellactually", "0.12.0");
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "dist", "wellactually.mjs"), "// the plugin\n");
  fs.writeFileSync(path.join(root, "hooks", "hooks.json"), JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "node hook.mjs" }] }],
      PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "node hook.mjs" }] }],
    },
  }));
});

function trust(events: Record<string, string>, extra = ""): void {
  const tables = Object.entries(events).map(([event, fields]) => `[hooks.state."wellactually@market:hooks/hooks.json:${event}:0:0"]\n${fields}\n`);
  fs.writeFileSync(path.join(home, "config.toml"), `model = "x"\n\n${tables.join("\n")}${extra}`);
}

const env = () => ({ CODEX_HOME: home });

test("hooks trusted for this exact folder run", () => {
  const content = `trusted_hash = "sha256:def"\ntrusted_content_hash = "${pluginContentHash(root)}"`;
  trust({ session_start: content, post_tool_use: content });
  expect(codexHookTrust(root, env())).toEqual({ state: "trusted" });
});

test("an update that changed any file of the plugin sends its hooks back for review", () => {
  const content = `trusted_hash = "sha256:def"\ntrusted_content_hash = "${pluginContentHash(root)}"`;
  trust({ session_start: content, post_tool_use: content });
  fs.writeFileSync(path.join(root, "dist", "wellactually.mjs"), "// the next release\n");
  expect(codexHookTrust(root, env())).toEqual({ state: "needs-review", events: ["SessionStart", "PostToolUse"] });
});

test("a hook never trusted needs review, one switched off on purpose does not", () => {
  trust({ session_start: `trusted_hash = "sha256:def"`, post_tool_use: "enabled = false" });
  expect(codexHookTrust(root, env())).toEqual({ state: "trusted" });
  trust({ session_start: `trusted_hash = "sha256:def"` });
  expect(codexHookTrust(root, env())).toEqual({ state: "needs-review", events: ["PostToolUse"] });
});

test("outside a Codex plugin install, or without a config, there is nothing to judge", () => {
  expect(codexHookTrust(path.join(home, "elsewhere"), env())).toBeNull();
  expect(codexHookTrust(root, env())).toBeNull();
});

test("a later table of the same hook wins, and other sections end a table", () => {
  const states = hookStates([
    `[hooks.state."a"]`, `trusted_hash = "old"`,
    `[notice]`, `trusted_hash = "not a hook"`,
    `[hooks.state."a"]`, `trusted_hash = "new"`, `trusted_content_hash = "c"`,
  ].join("\n"));
  expect(states.get("a")).toEqual({ trustedHash: "new", contentHash: "c" });
});

test("the fingerprint matches Codex's for a known folder", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "wa-fingerprint-"));
  fs.writeFileSync(path.join(folder, "a"), "x");
  expect(pluginContentHash(folder)).toBe(pluginContentHashReference(folder));
});

/** The Rust algorithm written out step by step, independent of the port's loop. */
function pluginContentHashReference(folder: string): string {
  const u64 = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };
  return "sha256:" + crypto.createHash("sha256")
    .update("codex-plugin-bundle-v1")
    .update(u64(0)).update("directory")
    .update(u64(1)).update("a").update("file").update(u64(1)).update("x")
    .digest("hex");
}
