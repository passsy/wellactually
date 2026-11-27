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

/** A JSON file that holds an object, or {} for anything else: missing, garbage, null, an array or a string. */
const readObject = file => {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
};
const state = readObject(path.join(runtime, "state.json"));
/** Whether a release's `engines.node`, such as `>=20.3`, rules out the Node this runs on: each agent may bring its own. */
const tooOldFor = engines => {
  const wanted = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(typeof engines === "string" ? engines : "");
  const have = process.versions.node.split(".").map(Number);
  for (let i = 0; wanted && i < 3; i++) if (have[i] !== Number(wanted[i + 1] ?? 0)) return have[i] < Number(wanted[i + 1] ?? 0);
  return false;
};
const tooOld = root => tooOldFor(readObject(path.join(root, "package.json")).engines?.node);
// A release folder name: a semver version, so a state.json or registry answer can never name a path such as "..".
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
/** The npm dist-tag followed: `latest` unless state.json names a plain tag, so every check below compares the same value. */
const channelOf = value => (typeof value === "string" && /^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(value) ? value : "latest");
/** Whether a release folder holds the files the shim starts, so a deleted or half-removed one counts as not installed. */
const complete = root => ["dist/wellactually.mjs", "dist/wellactually-hook.mjs"].every(entry => fs.statSync(path.join(root, entry), { throwIfNoEntry: false })?.isFile());
const roots = [state.current, state.previous].filter(v => typeof v === "string" && VERSION.test(v)).map(v => path.join(runtime, "versions", v)).filter(root => !tooOld(root));
roots.push(plugin);
// The updater must survive a release that breaks it: when it fails it falls back, down to the copy in the plugin.
const recovers = command === "update" || command === "check-update";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Starts `shim.mjs <task>` in the background when the stamp file `name` is a day old, so the hook does not wait for npm. */
const daily = (name, task) => {
  try {
    const stamp = path.join(runtime, name);
    // A stamp from the future, left by a clock that ran ahead, counts as old rather than blocking the check until that date.
    const age = Date.now() - (fs.statSync(stamp, { throwIfNoEntry: false })?.mtimeMs ?? 0);
    if (age >= 0 && age < DAY_MS) return;
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(stamp, "");
    const log = fs.openSync(path.join(runtime, "..", "sync.log"), "a");
    spawn(process.execPath, [fileURLToPath(import.meta.url), task], { detached: true, windowsHide: true, stdio: ["ignore", log, log] }).unref();
    fs.closeSync(log);
  } catch {}
};

// Once a day the first hook starts both updaters itself, so even a release that breaks its hooks gets replaced.
// WELLACTUALLY_UPDATE_CHECK=0 and the usual switches keep both off the network; WELLACTUALLY_AUTO_UPDATE=0 alone still checks for the notice.
// The stamps are per Node major: a host on an old Node, which cannot install a release that needs a newer one, does not use up the day of a host that can.
const quiet = process.env.WELLACTUALLY_UPDATE_CHECK === "0" || process.env.NO_UPDATE_NOTIFIER || process.env.CI;
if (command === "hook" && !quiet) {
  const node = process.versions.node.split(".")[0];
  daily(`checked-node${node}`, "check-update");
  if (process.env.WELLACTUALLY_AUTO_UPDATE !== "0" && !state.pinned) daily(`rescue-checked-node${node}`, "rescue-update");
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
  const started = Date.now();
  const channel = channelOf(state.channel);
  const registry = (env.WELLACTUALLY_NPM_REGISTRY || "https://registry.npmjs.org/wellactually").replace(/\/+$/, "");
  const response = await fetch(`${registry}/${channel}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`npm has no wellactually release ${channel} (${response.status})`);
  const { version, dist, engines } = (await response.json()) ?? {};
  if (typeof version !== "string" || !VERSION.test(version) || typeof dist?.tarball !== "string" || typeof dist?.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(dist.integrity)) {
    throw new Error(`npm answered for ${channel} without a version, tarball and sha512 integrity`);
  }
  fs.mkdirSync(runtime, { recursive: true });
  const seenFile = path.join(runtime, "rescue.json");
  if (version === state.current && complete(path.join(runtime, "versions", version))) {
    fs.rmSync(seenFile, { force: true });
    return;
  }
  // The wait counts from when the runtime was first seen behind this channel, from the release it still runs: a run of
  // quick releases does not restart it, while a first updater that works moves `current` and gets a fresh two days.
  const from = state.current ?? null;
  let seen = readObject(seenFile);
  if (seen.registry !== registry || seen.channel !== channel || seen.from !== from || !Number.isFinite(seen.since) || seen.since > Date.now()) {
    seen = { registry, channel, from, since: started };
    const temp = `${seenFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(seen));
    fs.renameSync(temp, seenFile);
  }
  // The first updater gets two days; a current release whose files are gone is repaired at once.
  if (version !== state.current && Date.now() - seen.since < 2 * DAY_MS) return;
  // A release for a newer Node than this one is left to a host that has it, without downloading it every day.
  if (tooOldFor(engines?.node)) return;
  console.error(`the runtime has run ${from ?? "the plugin's bundled copy"} since ${new Date(seen.since).toISOString()} while ${channel} names ${version}: installing it`);

  // Plain https without credentials, at every redirect; http only to a loopback registry named in WELLACTUALLY_NPM_REGISTRY, as in tests.
  const localRegistry = Boolean(env.WELLACTUALLY_NPM_REGISTRY) && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(`${registry}/`);
  let url = new URL(dist.tarball);
  let download;
  for (let hop = 0; ; hop++) {
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if ((url.protocol !== "https:" && !(localRegistry && loopback && url.protocol === "http:")) || url.username || url.password) throw new Error(`npm pointed at ${url.origin}, which is not a plain https address`);
    download = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
    const location = download.headers.get("location");
    if (download.status < 300 || download.status >= 400 || !location) break;
    if (hop === 5) throw new Error(`${dist.tarball} redirects more than five times`);
    url = new URL(location, url);
  }
  if (!download.ok) throw new Error(`could not download ${dist.tarball} (${download.status})`);
  const MAX_BYTES = 100 * 1024 * 1024;
  if (Number(download.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error("the release is larger than 100 MB");
  const chunks = [];
  let size = 0;
  for await (const chunk of download.body ?? []) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error("the release is larger than 100 MB");
    chunks.push(chunk);
  }
  const tarball = Buffer.concat(chunks);
  const digest = crypto.createHash("sha512").update(tarball).digest("base64");
  if (`sha512-${digest}` !== dist.integrity) throw new Error("the downloaded release does not match the integrity npm published for it");

  // The same lock as the first updater. Both start from the same hook, so this one waits a little for the other to finish.
  const lock = path.join(runtime, "install.lock");
  const token = `${process.pid}.${crypto.randomUUID()}`;
  let locked = false;
  for (let attempt = 0; attempt < 10 && !locked; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      // A lock older than ten minutes, or from the future, belongs to a process that is gone.
      const age = Date.now() - fs.statSync(lock).mtimeMs;
      if (age > 10 * 60 * 1000 || age < -60 * 1000) {
        const taken = `${lock}.${token}`;
        fs.renameSync(lock, taken);
        fs.rmSync(taken, { force: true });
      }
    } catch {}
    try {
      fs.writeFileSync(lock, token, { flag: "wx" });
      locked = true;
    } catch {}
  }
  if (!locked) return;
  // shortcut: two processes that both find the lock stale at the same moment can both get in; each unpacks into its own staging folder and every switch is a rename, so the worst case is one failed install that the next day retries.
  try {
    const now = readObject(path.join(runtime, "state.json"));
    // Another install while this one downloaded wins: its release may be newer than what this one resolved.
    if (now.pinned || channelOf(now.channel) !== channel || now.current !== state.current) return;
    const versions = path.join(runtime, "versions");
    fs.mkdirSync(versions, { recursive: true });
    const staging = fs.mkdtempSync(path.join(versions, ".staging-"));
    const tar = args => execFileSync("tar", args, { cwd: staging, encoding: "utf8", windowsHide: true });
    try {
      fs.writeFileSync(path.join(staging, "release.tgz"), tarball);
      // Only plain files and folders inside package/, listed before anything is unpacked.
      for (const name of tar(["-tzf", "release.tgz"]).split(/\r?\n/).filter(Boolean)) {
        const parts = name.replace(/\\/g, "/").split("/");
        if (parts[0] !== "package" || parts.includes("..") || path.isAbsolute(name)) throw new Error(`the release archive holds ${name}, outside its package folder`);
      }
      for (const line of tar(["-tvzf", "release.tgz"]).split(/\r?\n/).filter(Boolean)) {
        if (line[0] !== "-" && line[0] !== "d") throw new Error(`the release archive holds a link or special file: ${line}`);
      }
      tar(["-xzf", "release.tgz"]);
      const unpacked = path.join(staging, "package");
      const manifest = readObject(path.join(unpacked, "package.json"));
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
      if (installed !== digest || !complete(target)) {
        let old;
        if (fs.existsSync(target)) {
          old = path.join(versions, `.old-${version}-${crypto.randomUUID()}`);
          rename(target, old);
        }
        try {
          rename(unpacked, target);
        } catch (error) {
          // Put the old folder back, so state.json never names a release that is gone.
          if (old) rename(old, target);
          throw error;
        }
        if (old) touch(old);
      }
      // npm dates archive entries 1985; the first updater prunes by age, counting from now.
      touch(target);
      if (now.current) touch(path.join(versions, now.current));
      const temp = path.join(runtime, `state.json.${process.pid}.tmp`);
      fs.writeFileSync(temp, `${JSON.stringify({ ...now, previous: now.current && now.current !== version ? now.current : now.previous, current: version }, null, 2)}\n`);
      try {
        rename(temp, path.join(runtime, "state.json"));
      } catch (error) {
        fs.rmSync(temp, { force: true });
        throw error;
      }
      fs.rmSync(seenFile, { force: true });
      console.log(`Installed Well Actually ${version} with the second updater.`);
    } finally {
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch {}
    }
  } finally {
    try {
      if (fs.readFileSync(lock, "utf8") === token) fs.rmSync(lock, { force: true });
    } catch {}
  }
}

/** A rename that retries briefly where Windows holds a fresh file open, for a virus scanner or an indexer. */
function rename(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.renameSync(from, to);
    } catch (error) {
      if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(error?.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

function touch(file) {
  try {
    fs.utimesSync(file, new Date(), new Date());
  } catch {}
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
