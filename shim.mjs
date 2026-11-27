#!/usr/bin/env node
// The one entry point of the Claude Code and Codex plugins: hooks run `shim.mjs hook`, the MCP server `shim.mjs mcp`,
// skills `shim.mjs <command>`. Codex approves a plugin's hooks against a hash of the whole plugin folder, so this
// file and the plugin around it stay unchanged between releases. It runs the Well Actually runtime the plugin
// downloads into <WELLACTUALLY_HOME>/runtime, or the copy bundled with the plugin until there is one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const plugin = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.join(process.env.WELLACTUALLY_HOME || path.join(os.homedir(), ".wellactually"), "runtime");
const [command = "", ...rest] = process.argv.slice(2);
const entries = { hook: "wellactually-hook.mjs", review: "review.mjs" };
const file = entries[command] ?? "wellactually.mjs";
const args = command in entries ? rest : [command, ...rest];

let state = {};
try {
  state = JSON.parse(fs.readFileSync(path.join(runtime, "state.json"), "utf8"));
} catch {}
const roots = [state.current, state.previous].filter(v => typeof v === "string" && /^[0-9A-Za-z.+-]+$/.test(v)).map(v => path.join(runtime, "versions", v));
roots.push(plugin);

// The runtime finds the plugin it serves here, not beside its own files.
process.env.WELLACTUALLY_PLUGIN_ROOT = plugin;
for (const root of roots) {
  const entry = path.join(root, "dist", file);
  if (!fs.existsSync(entry)) continue;
  // The runtime finds its worker, log writer and background command beside the file it was started as.
  process.argv = [process.argv[0], entry, ...args];
  try {
    await import(pathToFileURL(entry).href);
    break;
  } catch (error) {
    // Only a release that cannot load falls back to the one before; an error while it runs is its own.
    if (!(error instanceof SyntaxError) && error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  }
}
