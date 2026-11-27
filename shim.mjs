#!/usr/bin/env node
// The one entry point of the Claude Code, Codex, OpenCode and pi plugins: hooks run `shim.mjs hook`, the MCP server
// `shim.mjs mcp`, skills `shim.mjs <command>`. Codex approves a plugin's hooks against a hash of the whole plugin
// folder, so this file and the plugin around it stay unchanged between releases. It runs the Well Actually runtime the
// plugin downloads into <WELLACTUALLY_HOME>/runtime, or the copy bundled with the plugin until there is one.
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
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

const DAY_MS = 24 * 60 * 60 * 1000;
const VERSION = /^[0-9A-Za-z.+-]+$/;

/** Starts `shim.mjs <task>` in the background when the stamp file `name` is a day old, so the hook does not wait for npm. */
const daily = (name, task) => {
  try {
    const stamp = path.join(runtime, name);
    if (Date.now() - (fs.statSync(stamp, { throwIfNoEntry: false })?.mtimeMs ?? 0) < DAY_MS) return;
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(stamp, "");
    const log = fs.openSync(path.join(runtime, "..", "sync.log"), "a");
    spawn(process.execPath, [fileURLToPath(import.meta.url), task], { detached: true, windowsHide: true, stdio: ["ignore", log, log] }).unref();
  } catch {}
};

// Once a day the first hook starts both updaters itself, so even a release that breaks its hooks gets replaced.
if (command === "hook") {
  daily("checked", "check-update");
  daily("rescue-checked", "rescue-update");
}

/**
 * The second updater, for when the first one, the runtime's own `check-update`, fails without noticing: it lives in
 * this frozen file and runs no downloaded code. It installs the release the followed npm dist-tag names once that
 * release has been out for two days and is still not the current one. It follows the same rules as the first:
 * a pin stops it, a moved tag is followed back too, and the archive is checked before it becomes current.
 */
async function rescue() {
  const env = process.env;
  if (env.WELLACTUALLY_AUTO_UPDATE === "0" || env.WELLACTUALLY_UPDATE_CHECK === "0" || env.NO_UPDATE_NOTIFIER || env.CI || state.pinned) return;
  const channel = typeof state.channel === "string" && /^[0-9A-Za-z._-]+$/.test(state.channel) ? state.channel : "latest";
  const registry = env.WELLACTUALLY_NPM_REGISTRY || "https://registry.npmjs.org/wellactually";
  const response = await fetch(`${registry}/${channel}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`npm has no wellactually release ${channel} (${response.status})`);
  const { version, dist } = (await response.json()) ?? {};
  if (typeof version !== "string" || !VERSION.test(version) || typeof dist?.tarball !== "string" || !/^sha512-/.test(dist?.integrity ?? "")) {
    throw new Error(`npm answered for ${channel} without a version, tarball and sha512 integrity`);
  }
  const seenFile = path.join(runtime, "rescue.json");
  if (version === state.current) {
    fs.rmSync(seenFile, { force: true });
    return;
  }
  let seen = {};
  try {
    seen = JSON.parse(fs.readFileSync(seenFile, "utf8")) || {};
  } catch {}
  if (seen.version !== version || typeof seen.since !== "number") {
    seen = { version, since: Date.now() };
    fs.writeFileSync(seenFile, JSON.stringify(seen));
  }
  // The first updater gets two days to install it; only then is it failing.
  if (Date.now() - seen.since < 2 * DAY_MS) return;
  console.error(`${channel} has named ${version} for two days and the runtime still runs ${state.current ?? "the plugin's bundled copy"}: installing it`);

  const url = new URL(dist.tarball);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) || url.username || url.password) throw new Error(`npm pointed at ${url.origin}, which is not a plain https address`);
  const download = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!download.ok) throw new Error(`could not download ${dist.tarball} (${download.status})`);
  const tarball = Buffer.from(await download.arrayBuffer());
  if (tarball.length > 100 * 1024 * 1024) throw new Error("the release is larger than 100 MB");
  const digest = crypto.createHash("sha512").update(tarball).digest("base64");
  if (`sha512-${digest}` !== dist.integrity) throw new Error("the downloaded release does not match the integrity npm published for it");

  // The same lock as the first updater: whoever holds it installs, the other one skips.
  const lock = path.join(runtime, "install.lock");
  const token = `${process.pid}.${crypto.randomUUID()}`;
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs > 10 * 60 * 1000) {
      const taken = `${lock}.${token}`;
      fs.renameSync(lock, taken);
      fs.rmSync(taken, { force: true });
    }
  } catch {}
  try {
    fs.writeFileSync(lock, token, { flag: "wx" });
  } catch {
    return;
  }
  try {
    let now = {};
    try {
      now = JSON.parse(fs.readFileSync(path.join(runtime, "state.json"), "utf8")) || {};
    } catch {}
    if (now.pinned || (now.channel ?? "latest") !== channel || now.current === version) return;
    const versions = path.join(runtime, "versions");
    fs.mkdirSync(versions, { recursive: true });
    const staging = fs.mkdtempSync(path.join(versions, ".staging-"));
    try {
      fs.writeFileSync(path.join(staging, "release.tgz"), tarball);
      // Only plain files and folders inside package/, listed before anything is unpacked.
      for (const name of execFileSync("tar", ["-tzf", "release.tgz"], { cwd: staging, encoding: "utf8" }).split(/\r?\n/).filter(Boolean)) {
        const parts = name.replace(/\\/g, "/").split("/");
        if (parts[0] !== "package" || parts.includes("..") || path.isAbsolute(name)) throw new Error(`the release archive holds ${name}, outside its package folder`);
      }
      for (const line of execFileSync("tar", ["-tvzf", "release.tgz"], { cwd: staging, encoding: "utf8" }).split(/\r?\n/).filter(Boolean)) {
        if (line[0] !== "-" && line[0] !== "d") throw new Error(`the release archive holds a link or special file: ${line}`);
      }
      execFileSync("tar", ["-xzf", "release.tgz"], { cwd: staging, stdio: "ignore" });
      const unpacked = path.join(staging, "package");
      const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, "package.json"), "utf8"));
      if (manifest.name !== "wellactually" || manifest.version !== version) throw new Error(`npm announced ${version}, the archive holds ${manifest.name}@${manifest.version}`);
      for (const entry of ["dist/wellactually.mjs", "dist/wellactually-hook.mjs", "shim.mjs"]) {
        if (!fs.statSync(path.join(unpacked, entry), { throwIfNoEntry: false })?.isFile()) throw new Error(`${version} cannot run as the plugin's runtime: it lacks ${entry}`);
      }
      if (tooOld(unpacked)) throw new Error(`${version} needs Node ${manifest.engines?.node}, this is ${process.versions.node}`);
      fs.writeFileSync(path.join(unpacked, ".integrity"), digest);
      const target = path.join(versions, version);
      let installed;
      try {
        installed = fs.readFileSync(path.join(target, ".integrity"), "utf8");
      } catch {}
      if (installed !== digest) {
        if (fs.existsSync(target)) {
          const old = path.join(versions, `.old-${version}-${crypto.randomUUID()}`);
          fs.renameSync(target, old);
          fs.utimesSync(old, new Date(), new Date());
        }
        fs.renameSync(unpacked, target);
      }
      // npm dates archive entries 1985; the first updater prunes by age, counting from now.
      fs.utimesSync(target, new Date(), new Date());
      if (now.current) {
        try {
          fs.utimesSync(path.join(versions, now.current), new Date(), new Date());
        } catch {}
      }
      const temp = path.join(runtime, `state.json.${process.pid}.tmp`);
      fs.writeFileSync(temp, `${JSON.stringify({ ...now, previous: now.current ?? now.previous, current: version }, null, 2)}\n`);
      fs.renameSync(temp, path.join(runtime, "state.json"));
      fs.rmSync(seenFile, { force: true });
      console.log(`Installed Well Actually ${version} with the second updater.`);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  } finally {
    try {
      if (fs.readFileSync(lock, "utf8") === token) fs.rmSync(lock, { force: true });
    } catch {}
  }
}

if (command === "rescue-update") {
  try {
    await rescue();
  } catch (error) {
    console.error(`rescue-update failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
} else {
  await run();
}

async function run() {
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
}
