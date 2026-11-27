#!/usr/bin/env node
// The one entry point of the Claude Code and Codex plugins: hooks run `shim.mjs hook`, the MCP server `shim.mjs mcp`,
// skills `shim.mjs <command>`. Codex approves a plugin's hooks against a hash of the whole plugin folder, so this
// file and the plugin around it stay unchanged between releases. It runs the Well Actually runtime the plugin
// downloads into <WELLACTUALLY_HOME>/runtime, or the copy bundled with the plugin until there is one.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const plugin = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.join(process.env.WELLACTUALLY_HOME || path.join(os.homedir(), ".wellactually"), "runtime");
const [command = "", ...rest] = process.argv.slice(2);
const entries = { hook: "wellactually-hook.mjs", review: "review.mjs" };
const file = entries[command] ?? "wellactually.mjs";
const args = command in entries ? rest : process.argv.slice(2);

let state = {};
try {
  state = JSON.parse(fs.readFileSync(path.join(runtime, "state.json"), "utf8")) || {};
} catch {}
/** Whether a release's `engines.node`, such as `>=20.3`, rules out the Node this runs on: each agent may bring its own. */
const tooOld = root => {
  try {
    const wanted = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).engines?.node ?? "");
    const have = process.versions.node.split(".").map(Number);
    for (let i = 0; wanted && i < 3; i++) if (have[i] !== Number(wanted[i + 1] ?? 0)) return have[i] < Number(wanted[i + 1] ?? 0);
  } catch {}
  return false;
};
const roots = [state.current, state.previous].filter(v => typeof v === "string" && /^[0-9A-Za-z.+-]+$/.test(v)).map(v => path.join(runtime, "versions", v)).filter(root => !tooOld(root));
roots.push(plugin);
// The updater must survive a release that breaks it: when it fails it falls back, down to the copy in the plugin.
const recovers = command === "update" || command === "check-update";

// Once a day the first hook starts the update check itself, so even a release that breaks its hooks gets replaced.
if (command === "hook") {
  try {
    const stamp = path.join(runtime, "checked");
    if (Date.now() - (fs.statSync(stamp, { throwIfNoEntry: false })?.mtimeMs ?? 0) >= 24 * 60 * 60 * 1000) {
      fs.mkdirSync(runtime, { recursive: true });
      fs.writeFileSync(stamp, "");
      const log = fs.openSync(path.join(runtime, "..", "sync.log"), "a");
      spawn(process.execPath, [fileURLToPath(import.meta.url), "check-update"], { detached: true, windowsHide: true, stdio: ["ignore", log, log] }).unref();
    }
  } catch {}
}

// The runtime finds the plugin it serves here, not beside its own files.
process.env.WELLACTUALLY_PLUGIN_ROOT = plugin;
for (const root of roots) {
  const entry = path.join(root, "dist", file);
  if (!fs.existsSync(entry)) continue;
  // The runtime finds its worker, log writer and background command beside the file it was started as.
  process.argv = [process.argv[0], entry, ...args];
  try {
    await import(pathToFileURL(entry).href);
    if (!recovers || !process.exitCode || root === plugin) break;
    // The updater of this release failed, maybe through a bug of its own: the one before tries too.
    console.error(`${path.basename(root)} could not update, trying the release before it`);
    process.exitCode = undefined;
  } catch (error) {
    // Only a release that cannot load falls back to the one before; an error while it runs is its own.
    if (root === plugin || (!recovers && !(error instanceof SyntaxError) && error?.code !== "ERR_MODULE_NOT_FOUND")) throw error;
    if (recovers) console.error(`${path.basename(root)} failed to load (${error?.message ?? error}), trying the release before it`);
  }
}
