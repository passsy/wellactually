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

export const REGISTRY = "https://registry.npmjs.org/wellactually";
const KEEP = 3;
const LOCK_STALE_MS = 10 * 60 * 1000;

export function runtimeDir(): string {
  return path.join(boardHome(), "runtime");
}

function stateFile(): string {
  return path.join(runtimeDir(), "state.json");
}

export function readRuntime(): RuntimeState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8")) as RuntimeState;
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
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
  } catch {}
  let fd: number;
  try {
    fd = fs.openSync(lock, "wx");
  } catch {
    return undefined;
  }
  try {
    return run();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

/** Checks a tarball against the `sha512-<base64>` integrity npm publishes for it. */
export function verifyIntegrity(tarball: Buffer, integrity: string): void {
  const [algorithm, expected] = integrity.split("-", 2);
  if (algorithm !== "sha512" || !expected) throw new Error(`unsupported integrity ${integrity}`);
  const actual = crypto.createHash("sha512").update(tarball).digest("base64");
  if (actual !== expected) throw new Error("the downloaded release does not match the integrity npm published for it");
}

/**
 * Unpacks an npm tarball of the wellactually package into the runtime and
 * makes it current. Returns the version, or undefined when another process
 * holds the install lock.
 */
export function installTarball(tarball: Buffer, { pin = false, channel }: { pin?: boolean; channel?: string } = {}): string | undefined {
  return withLock(() => {
    const versions = path.join(runtimeDir(), "versions");
    fs.mkdirSync(versions, { recursive: true });
    const staging = fs.mkdtempSync(path.join(versions, ".staging-"));
    try {
      const file = path.join(staging, "release.tgz");
      fs.writeFileSync(file, tarball);
      execFileSync("tar", ["-xzf", file, "-C", staging], { stdio: "ignore" });
      const unpacked = path.join(staging, "package");
      const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, "package.json"), "utf8")) as { name?: string; version?: string };
      if (manifest.name !== "wellactually" || !manifest.version || !/^[0-9A-Za-z.+-]+$/.test(manifest.version)) throw new Error("this is not a wellactually release");
      for (const entry of ["dist/wellactually.mjs", "dist/wellactually-hook.mjs", "shim.mjs"]) {
        // A release without the shim predates this runtime: it cannot update itself, so the install would be stuck on it.
        if (!fs.existsSync(path.join(unpacked, entry))) throw new Error(`${manifest.version} cannot run as the plugin's runtime: it lacks ${entry}`);
      }
      const target = path.join(versions, manifest.version);
      // A release that is already there stays as it is: running sessions may be loading files from it.
      if (!fs.existsSync(target)) fs.renameSync(unpacked, target);
      const state = readRuntime();
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

/** Keeps the current and previous release and the newest others, up to KEEP. */
function prune(): void {
  const state = readRuntime();
  const versions = path.join(runtimeDir(), "versions");
  const others = fs.readdirSync(versions)
    .filter(name => !name.startsWith(".") && name !== state.current && name !== state.previous)
    .map(name => ({ name, at: fs.statSync(path.join(versions, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const { name } of others.slice(Math.max(0, KEEP - 2))) {
    fs.rmSync(path.join(versions, name), { recursive: true, force: true });
  }
}

interface Release {
  version: string;
  dist: { tarball: string; integrity: string };
}

/** The release a dist-tag or an exact version names on npm. */
export async function resolveRelease(tagOrVersion: string, registry = process.env.WELLACTUALLY_REGISTRY || REGISTRY): Promise<Release> {
  const response = await fetch(`${registry}/${encodeURIComponent(tagOrVersion)}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`npm has no wellactually release ${tagOrVersion} (${response.status})`);
  const release = (await response.json()) as Release;
  if (typeof release.version !== "string" || typeof release.dist?.tarball !== "string" || typeof release.dist?.integrity !== "string") {
    throw new Error(`npm answered for ${tagOrVersion} without a version, tarball and integrity`);
  }
  return release;
}

async function download(release: Release): Promise<Buffer> {
  const response = await fetch(release.dist.tarball, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`could not download ${release.dist.tarball} (${response.status})`);
  const tarball = Buffer.from(await response.arrayBuffer());
  verifyIntegrity(tarball, release.dist.integrity);
  return tarball;
}

/**
 * `wellactually update`. `from` installs a local tarball, `version` pins one
 * exact release, `channel` follows a dist-tag from now on. Without any of
 * them it moves to the newest release of the channel already followed.
 */
export async function update(options: { channel?: string; version?: string; from?: string; registry?: string } = {}): Promise<string> {
  if (options.from) {
    const version = installTarball(fs.readFileSync(options.from), { pin: true });
    return version ? `Installed ${version} from ${options.from}. Auto-update is paused until you run update --channel latest.` : "Another install is running; try again in a moment.";
  }
  const state = readRuntime();
  const channel = options.channel ?? state.channel ?? "latest";
  const release = await resolveRelease(options.version ?? channel, options.registry);
  const pin = Boolean(options.version);
  if (release.version === state.current) {
    writeRuntime({ ...state, channel, pinned: pin });
    return `Well Actually ${release.version} is already installed${pin ? " and pinned" : `, following ${channel}`}.`;
  }
  const version = installTarball(await download(release), { pin, channel });
  if (!version) return "Another install is running; try again in a moment.";
  return `Installed Well Actually ${version}${pin ? ", pinned: auto-update is paused until you run update --channel latest" : `, following ${channel}`}. New sessions use it.`;
}

/** The background auto-update, started at most once a day from SessionStart. Silent: a failure waits for the next day. */
export async function autoUpdate(env = process.env): Promise<void> {
  const state = readRuntime();
  if (autoUpdateOff(env) || state.pinned) return;
  try {
    await update({ registry: env.WELLACTUALLY_REGISTRY || REGISTRY });
  } catch (error) {
    // Offline or npm down: the current release keeps running. The reason goes to sync.log, where the background command writes.
    console.error(`auto-update failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
