import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { boardHome } from "../../board/src/board.ts";

/**
 * The Well Actually runtime the Claude Code and Codex plugins run.
 *
 * The plugins are frozen shells: their hooks and MCP server run `shim.mjs`,
 * which never changes, so Codex keeps the approval it pins to a hash of the
 * plugin folder. The shim runs the release named here, which this module
 * downloads from npm and swaps in. A release lives in
 * `<home>/runtime/versions/<version>/`, the unpacked npm package.
 */
export interface RuntimeState {
  /** The release the shim runs. */
  current?: string;
  /** The release before it, which the shim falls back to when `current` cannot load. */
  previous?: string;
  /** The npm dist-tag auto-update follows, `latest` unless the user picked a preview channel. */
  channel?: string;
  /** Set when the user installed one exact version: auto-update leaves it alone. */
  pinned?: boolean;
}

/** Where releases come from. WELLACTUALLY_NPM_REGISTRY overrides it; WELLACTUALLY_REGISTRY is the advisory board and never serves code. */
export const REGISTRY = "https://registry.npmjs.org/wellactually";
/** A release stays this long after it stops being current or previous: a session started on it may still load files from it. */
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 10 * 60 * 1000;

export function runtimeDir(): string {
  return path.join(boardHome(), "runtime");
}

function stateFile(): string {
  return path.join(runtimeDir(), "state.json");
}

export function readRuntime(): RuntimeState {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(), "utf8")) as unknown;
    return state && typeof state === "object" && !Array.isArray(state) ? (state as RuntimeState) : {};
  } catch {
    return {};
  }
}

function writeRuntime(state: RuntimeState): void {
  fs.mkdirSync(runtimeDir(), { recursive: true });
  const temp = `${stateFile()}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  // The shim reads this file on every hook; a rename never shows it half written.
  fs.renameSync(temp, stateFile());
}

/** Whether auto-update is off: WELLACTUALLY_AUTO_UPDATE=0, or the usual update-check switches. */
export function autoUpdateOff(env: NodeJS.ProcessEnv): boolean {
  return env.WELLACTUALLY_AUTO_UPDATE === "0" || env.WELLACTUALLY_UPDATE_CHECK === "0" || Boolean(env.NO_UPDATE_NOTIFIER) || Boolean(env.CI);
}

/** One process installs at a time; the others skip, since the one running installs the same release. */
function withLock<T>(run: () => T): T | undefined {
  fs.mkdirSync(runtimeDir(), { recursive: true });
  const lock = path.join(runtimeDir(), "install.lock");
  const token = `${process.pid}.${crypto.randomUUID()}`;
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
      // Renaming takes the stale lock for one process only; the others find it gone and skip.
      const taken = `${lock}.${token}`;
      fs.renameSync(lock, taken);
      fs.rmSync(taken, { force: true });
    }
  } catch {}
  try {
    fs.writeFileSync(lock, token, { flag: "wx" });
  } catch {
    return undefined;
  }
  try {
    return run();
  } finally {
    // shortcut: a process that outlives LOCK_STALE_MS, or pauses between the stale check and the rename, can lose its lock to another installer; installs take seconds and every write is a rename.
    try {
      if (fs.readFileSync(lock, "utf8") === token) fs.rmSync(lock, { force: true });
    } catch {}
  }
}

/** Checks a tarball against the `sha512-<base64>` integrity npm publishes for it. */
export function verifyIntegrity(tarball: Buffer, integrity: string): void {
  const [algorithm, expected] = integrity.split("-", 2);
  if (algorithm !== "sha512" || !expected) throw new Error(`unsupported integrity ${integrity}`);
  const actual = crypto.createHash("sha512").update(tarball).digest("base64");
  if (actual !== expected) throw new Error("the downloaded release does not match the integrity npm published for it");
}

/** Lists the archive before unpacking it: only plain files and folders inside `package/`, so it cannot write outside the staging folder or link to anything. */
function checkArchive(dir: string, file: string): void {
  for (const name of execFileSync("tar", ["-tzf", file], { cwd: dir, encoding: "utf8" }).split(/\r?\n/).filter(Boolean)) {
    const parts = name.replace(/\\/g, "/").split("/");
    if (parts[0] !== "package" || parts.includes("..") || path.isAbsolute(name)) throw new Error(`the release archive holds ${name}, outside its package folder`);
  }
  for (const line of execFileSync("tar", ["-tvzf", file], { cwd: dir, encoding: "utf8" }).split(/\r?\n/).filter(Boolean)) {
    if (line[0] !== "-" && line[0] !== "d") throw new Error(`the release archive holds a link or special file: ${line}`);
  }
}

/** The lowest Node version an `engines.node` of the form `>=20` or `>=20.3.0` allows, compared with this one. */
function nodeTooOld(engines: string | undefined, version = process.versions.node): boolean {
  const wanted = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(engines ?? "");
  if (!wanted) return false;
  const have = version.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const want = Number(wanted[i + 1] ?? 0);
    if (have[i] !== want) return (have[i] ?? 0) < want;
  }
  return false;
}

/**
 * Unpacks an npm tarball of the wellactually package into the runtime and
 * makes it current. Returns the version, or undefined when another process
 * holds the install lock, or when `auto` and the user pinned a release meanwhile.
 */
export function installTarball(tarball: Buffer, { pin = false, channel, auto = false, version }: { pin?: boolean; channel?: string; auto?: boolean; version?: string } = {}): string | undefined {
  return withLock(() => {
    // Read under the lock: a pin or channel the user set while this download ran wins over it.
    const state = readRuntime();
    if (auto && (state.pinned || (state.channel ?? "latest") !== (channel ?? "latest"))) return undefined;
    const versions = path.join(runtimeDir(), "versions");
    fs.mkdirSync(versions, { recursive: true });
    const staging = fs.mkdtempSync(path.join(versions, ".staging-"));
    try {
      // tar runs in the staging folder on a relative name: a Windows drive letter reads as a remote host to GNU tar.
      fs.writeFileSync(path.join(staging, "release.tgz"), tarball);
      checkArchive(staging, "release.tgz");
      execFileSync("tar", ["-xzf", "release.tgz"], { cwd: staging, stdio: "ignore" });
      const unpacked = path.join(staging, "package");
      const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, "package.json"), "utf8")) as { name?: string; version?: string; engines?: { node?: string } };
      if (manifest.name !== "wellactually" || !manifest.version || !/^[0-9A-Za-z.+-]+$/.test(manifest.version)) throw new Error("this is not a wellactually release");
      for (const entry of ["dist/wellactually.mjs", "dist/wellactually-hook.mjs", "shim.mjs"]) {
        // A release without the shim predates this runtime: it cannot update itself, so the install would be stuck on it.
        if (!fs.statSync(path.join(unpacked, entry), { throwIfNoEntry: false })?.isFile()) throw new Error(`${manifest.version} cannot run as the plugin's runtime: it lacks ${entry}`);
      }
      if (version && manifest.version !== version) throw new Error(`npm announced ${version}, the archive holds ${manifest.version}`);
      if (nodeTooOld(manifest.engines?.node)) throw new Error(`${manifest.version} needs Node ${manifest.engines?.node}, this is ${process.versions.node}`);
      const digest = crypto.createHash("sha512").update(tarball).digest("base64");
      fs.writeFileSync(path.join(unpacked, ".integrity"), digest);
      const target = path.join(versions, manifest.version);
      let installed: string | undefined;
      try {
        installed = fs.readFileSync(path.join(target, ".integrity"), "utf8");
      } catch {}
      // The same bytes stay where they are, since running sessions may be loading files from them.
      // Other bytes under the same version, a local rebuild or a damaged folder, replace them; the old folder waits for prune.
      if (installed !== digest) {
        if (fs.existsSync(target)) {
          const old = path.join(versions, `.old-${manifest.version}-${crypto.randomUUID()}`);
          fs.renameSync(target, old);
          fs.utimesSync(old, new Date(), new Date());
        }
        fs.renameSync(unpacked, target);
      }
      // npm archives date every entry 1985; prune counts from the install.
      fs.utimesSync(target, new Date(), new Date());
      // A release that stops being current keeps KEEP_MS from now on for the sessions still running it.
      if (state.current && state.current !== manifest.version) {
        try {
          fs.utimesSync(path.join(versions, state.current), new Date(), new Date());
        } catch {}
      }
      writeRuntime({
        ...state,
        previous: state.current && state.current !== manifest.version ? state.current : state.previous,
        current: manifest.version,
        pinned: pin,
        channel: channel ?? state.channel,
      });
      prune();
      return manifest.version;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });
}

/** Removes releases that are neither current nor previous once KEEP_MS passed since they were installed. */
function prune(): void {
  const state = readRuntime();
  const versions = path.join(runtimeDir(), "versions");
  for (const name of fs.readdirSync(versions)) {
    if (name === state.current || name === state.previous || name.startsWith(".staging-")) continue;
    const dir = path.join(versions, name);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > KEEP_MS) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A file still open, as on Windows: the next install tries again.
    }
  }
}

interface Release {
  version: string;
  dist: { tarball: string; integrity: string };
}

/** The release a dist-tag or an exact version names on npm. */
export async function resolveRelease(tagOrVersion: string, registry = process.env.WELLACTUALLY_NPM_REGISTRY || REGISTRY): Promise<Release> {
  const response = await fetch(`${registry}/${encodeURIComponent(tagOrVersion)}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`npm has no wellactually release ${tagOrVersion} (${response.status})`);
  const release = (await response.json()) as Release;
  if (typeof release.version !== "string" || typeof release.dist?.tarball !== "string" || typeof release.dist?.integrity !== "string") {
    throw new Error(`npm answered for ${tagOrVersion} without a version, tarball and integrity`);
  }
  return release;
}

const MAX_BYTES = 100 * 1024 * 1024;

async function download(release: Release): Promise<Buffer> {
  const url = new URL(release.dist.tarball);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) || url.username || url.password) throw new Error(`npm pointed at ${url.origin}, which is not a plain https address`);
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`could not download ${release.dist.tarball} (${response.status})`);
  if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error(`the release is larger than ${MAX_BYTES} bytes`);
  const tarball = Buffer.from(await response.arrayBuffer());
  if (tarball.length > MAX_BYTES) throw new Error(`the release is larger than ${MAX_BYTES} bytes`);
  verifyIntegrity(tarball, release.dist.integrity);
  return tarball;
}

/**
 * `wellactually update`. `from` installs a local tarball, `version` pins one
 * exact release, `channel` follows a dist-tag from now on. Without any of
 * them it moves to the newest release of the channel already followed.
 */
export async function update(options: { channel?: string; version?: string; from?: string; registry?: string; auto?: boolean } = {}): Promise<string> {
  if (options.from) {
    const version = installTarball(fs.readFileSync(options.from), { pin: true });
    return version ? `Installed ${version} from ${options.from}. Auto-update is paused until you run update --channel latest.` : "Another install is running; try again in a moment.";
  }
  const state = readRuntime();
  const channel = options.channel ?? state.channel ?? "latest";
  const release = await resolveRelease(options.version ?? channel, options.registry);
  const pin = Boolean(options.version);
  if (release.version === state.current) {
    if (options.auto) return `Well Actually ${release.version} is already installed.`;
    const written = withLock(() => {
      const now = readRuntime();
      if (now.current !== release.version) return false;
      writeRuntime({ ...now, channel, pinned: pin });
      return true;
    });
    if (!written) return "Another install is running; try again in a moment.";
    return `Well Actually ${release.version} is already installed${pin ? " and pinned" : `, following ${channel}`}.`;
  }
  const version = installTarball(await download(release), { pin, channel, auto: options.auto, version: release.version });
  if (!version) return "Another install is running; try again in a moment.";
  return `Installed Well Actually ${version}${pin ? ", pinned: auto-update is paused until you run update --channel latest" : `, following ${channel}`}. New sessions use it.`;
}

/** The background auto-update, which the plugin's shim starts at most once a day. False when it failed, so the shim can retry with an older release. */
export async function autoUpdate(env = process.env): Promise<boolean> {
  const state = readRuntime();
  if (autoUpdateOff(env) || state.pinned) return true;
  try {
    await update({ registry: env.WELLACTUALLY_NPM_REGISTRY || REGISTRY, auto: true });
    return true;
  } catch (error) {
    // Offline or npm down: the current release keeps running. The reason goes to sync.log, where the background command writes.
    console.error(`auto-update failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
