import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { autoUpdate, installTarball, readRuntime, runtimeDir, update, verifyIntegrity } from "../src/runtime.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const saved = { ...process.env };
let work: string;

beforeEach(() => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wa-runtime-")));
  process.env.WELLACTUALLY_HOME = path.join(work, "home");
  delete process.env.CI;
  delete process.env.WELLACTUALLY_AUTO_UPDATE;
  // Nothing a test starts in the background reaches the real npm.
  process.env.WELLACTUALLY_NPM_REGISTRY = "http://127.0.0.1:9/wellactually";
});
afterEach(() => {
  process.env = { ...saved };
});

/** An npm tarball of a wellactually release whose entry points print what they ran with. `body` replaces their code. */
function release(version: string, body?: string, engines?: string): Buffer {
  const dir = path.join(work, `pack-${version}-${crypto.randomUUID()}`);
  const pkg = path.join(dir, "package");
  fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "wellactually", version, ...(engines ? { engines: { node: engines } } : {}) }));
  fs.writeFileSync(path.join(pkg, "shim.mjs"), "");
  for (const entry of ["wellactually.mjs", "wellactually-hook.mjs"]) {
    fs.writeFileSync(path.join(pkg, "dist", entry), body ?? `console.log(JSON.stringify({ version: ${JSON.stringify(version)}, entry: process.argv[1], args: process.argv.slice(2), plugin: process.env.WELLACTUALLY_PLUGIN_ROOT }));`);
  }
  execFileSync("tar", ["-czf", path.join(dir, "release.tgz"), "-C", dir, "package"]);
  return fs.readFileSync(path.join(dir, "release.tgz"));
}

/** A frozen plugin folder: the real shim and a bundled release. */
function plugin(bundled = "0.0.1"): string {
  const root = path.join(work, "plugin");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.copyFileSync(path.join(repo, "shim.mjs"), path.join(root, "shim.mjs"));
  for (const entry of ["wellactually.mjs", "wellactually-hook.mjs"]) {
    fs.writeFileSync(path.join(root, "dist", entry), `console.log(JSON.stringify({ version: ${JSON.stringify(bundled)}, entry: process.argv[1], args: process.argv.slice(2) }));`);
  }
  return root;
}

const shim = (root: string, ...args: string[]) => JSON.parse(execFileSync(process.execPath, [path.join(root, "shim.mjs"), ...args], { encoding: "utf8", env: process.env }).trim());

test("the shim runs the plugin's bundled release until a runtime is installed", () => {
  const root = plugin();
  expect(shim(root, "hook")).toEqual({ version: "0.0.1", entry: path.join(root, "dist/wellactually-hook.mjs"), args: [] });
});

test("the shim runs the installed runtime: the hook file for hooks, the command with its arguments otherwise", () => {
  const root = plugin();
  installTarball(release("1.0.0"));
  const versionDir = path.join(runtimeDir(), "versions/1.0.0");
  expect(shim(root, "hook")).toEqual({ version: "1.0.0", entry: path.join(versionDir, "dist/wellactually-hook.mjs"), args: [], plugin: root });
  expect(shim(root, "mcp")).toEqual({ version: "1.0.0", entry: path.join(versionDir, "dist/wellactually.mjs"), args: ["mcp"], plugin: root });
  expect(shim(root, "disable", "passsy/x")).toMatchObject({ args: ["disable", "passsy/x"] });
});

test("a release that cannot load falls back to the previous one", () => {
  const root = plugin();
  installTarball(release("1.0.0"));
  installTarball(release("1.1.0", "this is not javascript ("));
  expect(readRuntime()).toMatchObject({ current: "1.1.0", previous: "1.0.0" });
  expect(shim(root, "hook").version).toBe("1.0.0");
});

test("an error while the release runs is not hidden by running another release", () => {
  const root = plugin();
  installTarball(release("1.0.0", "throw new Error('boom');"));
  expect(() => shim(root, "hook")).toThrow(/boom/);
});

test("installing keeps recent releases for running sessions, and a pin pauses auto-update", async () => {
  for (const version of ["1.0.0", "1.1.0", "1.2.0"]) installTarball(release(version));
  const old = path.join(runtimeDir(), "versions/1.0.0");
  expect(fs.existsSync(old)).toBe(true);
  const weeksAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, weeksAgo, weeksAgo);
  installTarball(release("1.3.0"));
  expect(fs.readdirSync(path.join(runtimeDir(), "versions")).sort()).toEqual(["1.1.0", "1.2.0", "1.3.0"]);
  const tgz = path.join(work, "local.tgz");
  fs.writeFileSync(tgz, release("1.4.0-local.1"));
  expect(await update({ from: tgz })).toMatch(/Installed 1.4.0-local.1/);
  expect(readRuntime()).toMatchObject({ current: "1.4.0-local.1", previous: "1.3.0", pinned: true });
  await autoUpdate({ ...process.env, WELLACTUALLY_NPM_REGISTRY: "http://127.0.0.1:9" });
  expect(readRuntime().current).toBe("1.4.0-local.1");
});

test("a tarball that is not a wellactually release is refused and changes nothing", () => {
  const dir = path.join(work, "other");
  fs.mkdirSync(path.join(dir, "package"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package/package.json"), JSON.stringify({ name: "left-pad", version: "1.0.0" }));
  execFileSync("tar", ["-czf", path.join(dir, "x.tgz"), "-C", dir, "package"]);
  expect(() => installTarball(fs.readFileSync(path.join(dir, "x.tgz")))).toThrow(/not a wellactually release/);
  expect(readRuntime()).toEqual({});
});

test("a release from before the frozen plugin is refused, so the install never gets stuck on code that cannot update", () => {
  const dir = path.join(work, "old");
  fs.mkdirSync(path.join(dir, "package/dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package/package.json"), JSON.stringify({ name: "wellactually", version: "0.13.2" }));
  for (const entry of ["wellactually.mjs", "wellactually-hook.mjs"]) fs.writeFileSync(path.join(dir, "package/dist", entry), "");
  execFileSync("tar", ["-czf", path.join(dir, "x.tgz"), "-C", dir, "package"]);
  installTarball(release("1.0.0"));
  expect(() => installTarball(fs.readFileSync(path.join(dir, "x.tgz")))).toThrow(/cannot run as the plugin's runtime: it lacks shim.mjs/);
  expect(readRuntime().current).toBe("1.0.0");
});

test("integrity is checked against the sha512 npm publishes", () => {
  const tarball = release("1.0.0");
  const integrity = `sha512-${crypto.createHash("sha512").update(tarball).digest("base64")}`;
  expect(() => verifyIntegrity(tarball, integrity)).not.toThrow();
  expect(() => verifyIntegrity(Buffer.concat([tarball, Buffer.from("x")]), integrity)).toThrow(/does not match/);
  expect(() => verifyIntegrity(tarball, "sha1-abc")).toThrow(/unsupported/);
});

test("auto-update installs the channel's newest release from the registry and verifies it", async () => {
  const tarball = release("2.0.0");
  const integrity = `sha512-${crypto.createHash("sha512").update(tarball).digest("base64")}`;
  const http = await import("node:http");
  const server = http.createServer((request, response) => {
    if (request.url === "/wellactually/latest") response.end(JSON.stringify({ version: "2.0.0", dist: { tarball: `http://127.0.0.1:${(server.address() as { port: number }).port}/t.tgz`, integrity } }));
    else if (request.url === "/t.tgz") response.end(tarball);
    else response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const registry = `http://127.0.0.1:${(server.address() as { port: number }).port}/wellactually`;
    await autoUpdate({ ...process.env, WELLACTUALLY_NPM_REGISTRY: registry });
    expect(readRuntime()).toMatchObject({ current: "2.0.0", pinned: false });
    await autoUpdate({ ...process.env, WELLACTUALLY_NPM_REGISTRY: registry, WELLACTUALLY_AUTO_UPDATE: "0" });
    expect(await update({ registry })).toMatch(/already installed, following latest/);
  } finally {
    server.close();
  }
});

test("a state.json that holds null or garbage falls back to the bundled release", () => {
  const root = plugin();
  fs.mkdirSync(runtimeDir(), { recursive: true });
  for (const content of ["null", "[1]", "{"]) {
    fs.writeFileSync(path.join(runtimeDir(), "state.json"), content);
    expect(shim(root, "hook").version).toBe("0.0.1");
    expect(readRuntime()).toEqual({});
  }
});

test("an archive with a link or a path outside its package is refused before unpacking", () => {
  for (const make of [
    (pkg: string) => fs.symlinkSync("/etc/passwd", path.join(pkg, "dist/wellactually.mjs")),
    (pkg: string) => fs.symlinkSync("..", path.join(pkg, "escape")),
  ]) {
    const dir = fs.mkdtempSync(path.join(work, "evil-"));
    const pkg = path.join(dir, "package");
    fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "wellactually", version: "6.6.6" }));
    make(pkg);
    execFileSync("tar", ["-czf", path.join(dir, "x.tgz"), "-C", dir, "package"]);
    expect(() => installTarball(fs.readFileSync(path.join(dir, "x.tgz")))).toThrow(/link or special file/);
  }
  const dir = fs.mkdtempSync(path.join(work, "evil-"));
  fs.mkdirSync(path.join(dir, "other"));
  fs.writeFileSync(path.join(dir, "other/x"), "");
  execFileSync("tar", ["-czf", path.join(dir, "x.tgz"), "-C", dir, "other"]);
  expect(() => installTarball(fs.readFileSync(path.join(dir, "x.tgz")))).toThrow(/outside its package folder/);
  expect(readRuntime()).toEqual({});
});

test("a release that needs a newer Node is refused, and the shim skips one installed by an agent with a newer Node", () => {
  expect(() => installTarball(release("9.0.0", undefined, ">=999"))).toThrow(/needs Node >=999/);
  const root = plugin();
  installTarball(release("1.0.0"));
  installTarball(release("1.1.0"));
  fs.writeFileSync(path.join(runtimeDir(), "versions/1.1.0/package.json"), JSON.stringify({ name: "wellactually", version: "1.1.0", engines: { node: ">=999.1" } }));
  expect(shim(root, "hook").version).toBe("1.0.0");
});

test("a rebuilt release under the same version replaces the old bytes", () => {
  const root = plugin();
  installTarball(release("1.0.0-local.1", "console.log(JSON.stringify({ version: 'first' }));"));
  expect(shim(root, "hook").version).toBe("first");
  installTarball(release("1.0.0-local.1", "console.log(JSON.stringify({ version: 'second' }));"));
  expect(shim(root, "hook").version).toBe("second");
});

test("a pin made while auto-update downloads wins", () => {
  installTarball(release("1.0.0"), { pin: true });
  expect(installTarball(release("2.0.0"), { auto: true, resolvedFrom: "1.0.0" })).toBeUndefined();
  expect(readRuntime()).toMatchObject({ current: "1.0.0", pinned: true });
});

test("the updater falls back to the release before when the current one throws while loading", () => {
  const root = plugin();
  installTarball(release("1.0.0"));
  installTarball(release("1.1.0", "throw new TypeError('boom');"));
  expect(shim(root, "update")).toMatchObject({ version: "1.0.0", args: ["update"] });
  expect(() => shim(root, "hook")).toThrow(/boom/);
});

test("a second installer does not remove the lock of the one holding it", () => {
  const lock = path.join(runtimeDir(), "install.lock");
  installTarball(release("1.0.0"));
  fs.writeFileSync(lock, "someone else");
  expect(installTarball(release("1.1.0"))).toBeUndefined();
  expect(fs.readFileSync(lock, "utf8")).toBe("someone else");
});

test("the updater retries with the release before when the current one fails, and the shim without a command shows the help", () => {
  const root = plugin();
  installTarball(release("1.0.0"));
  installTarball(release("1.1.0", "process.exitCode = 1;"));
  expect(shim(root, "check-update")).toMatchObject({ version: "1.0.0", args: ["check-update"] });
  installTarball(release("1.2.0"));
  expect(shim(root)).toMatchObject({ version: "1.2.0", args: [] });
});

test("the first hook of the day starts the update check through the shim", async () => {
  const root = plugin();
  installTarball(release("1.0.0"));
  fs.writeFileSync(path.join(runtimeDir(), "versions/1.0.0/dist/wellactually.mjs"), "import fs from 'node:fs'; if (process.argv[2] === 'check-update') fs.writeFileSync(process.env.WELLACTUALLY_HOME + '/ran', process.argv[1]);");
  fs.writeFileSync(path.join(runtimeDir(), "versions/1.0.0/dist/wellactually-hook.mjs"), "");
  execFileSync(process.execPath, [path.join(root, "shim.mjs"), "hook"], { env: process.env });
  const ran = path.join(process.env.WELLACTUALLY_HOME as string, "ran");
  for (let i = 0; i < 50 && !fs.existsSync(ran); i++) await new Promise(resolve => setTimeout(resolve, 100));
  expect(fs.readFileSync(ran, "utf8")).toBe(path.join(runtimeDir(), "versions/1.0.0/dist/wellactually.mjs"));
  fs.rmSync(ran);
  // The second updater is started the same day, from the shim alone.
  expect(fs.existsSync(path.join(runtimeDir(), `rescue-checked-node${process.versions.node.split(".")[0]}`))).toBe(true);
  execFileSync(process.execPath, [path.join(root, "shim.mjs"), "hook"], { env: process.env });
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(fs.existsSync(ran)).toBe(false);
});

test("a release whose archive holds another version than npm announced, or that comes over plain http, is refused", async () => {
  const tarball = release("2.0.0");
  const integrity = `sha512-${crypto.createHash("sha512").update(tarball).digest("base64")}`;
  const http = await import("node:http");
  let announced = "2.0.1";
  let host = "127.0.0.1";
  const server = http.createServer((request, response) => {
    const port = (server.address() as { port: number }).port;
    if (request.url === "/wellactually/latest") response.end(JSON.stringify({ version: announced, dist: { tarball: `http://${host}:${port}/t.tgz`, integrity } }));
    else if (request.url === "/t.tgz") response.end(tarball);
    else response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const registry = `http://127.0.0.1:${(server.address() as { port: number }).port}/wellactually`;
    await expect(update({ registry })).rejects.toThrow(/npm announced 2.0.1, the archive holds 2.0.0/);
    announced = "2.0.0";
    host = "example.com";
    await expect(update({ registry })).rejects.toThrow(/not a plain https address/);
    expect(readRuntime()).toEqual({});
  } finally {
    server.close();
  }
});

test("a background download does not undo a channel the user picked meanwhile", () => {
  installTarball(release("1.0.0-next.1"), { channel: "next" });
  expect(installTarball(release("1.0.0"), { auto: true, channel: "latest", resolvedFrom: "1.0.0-next.1" })).toBeUndefined();
  expect(readRuntime()).toMatchObject({ current: "1.0.0-next.1", channel: "next" });
});

/** A registry that names `version` for `latest` and serves `tarball` for it. */
async function registryServing(version: string, tarball: Buffer, integrity = `sha512-${crypto.createHash("sha512").update(tarball).digest("base64")}`, beforeTarball?: () => void) {
  const http = await import("node:http");
  const serve = (next: string, bytes: Buffer) => {
    version = next;
    tarball = bytes;
    integrity = `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
  };
  const server = http.createServer((request, response) => {
    const port = (server.address() as { port: number }).port;
    if (request.url === "/wellactually/latest") response.end(JSON.stringify({ version, dist: { tarball: `http://127.0.0.1:${port}/t.tgz`, integrity } }));
    else if (request.url === "/t.tgz") {
      beforeTarball?.();
      response.end(tarball);
    } else response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/wellactually`, close: () => server.close(), serve };
}

/** Runs the shim's second updater; async, since the registry answers from this process. */
const rescue = (root: string, env: NodeJS.ProcessEnv) => promisify(execFile)(process.execPath, [path.join(root, "shim.mjs"), "rescue-update"], { env });
const rescueFile = () => path.join(runtimeDir(), "rescue.json");
const ageRescue = (days: number) => {
  const seen = JSON.parse(fs.readFileSync(rescueFile(), "utf8"));
  fs.writeFileSync(rescueFile(), JSON.stringify({ ...seen, since: seen.since - days * 24 * 60 * 60 * 1000 }));
};

test("the second updater installs the tag's release once the first has not for two days, running no downloaded code", async () => {
  const root = plugin();
  // The current release's own updater is broken without failing: it never installs anything.
  installTarball(release("1.0.0", "process.exit(0);"));
  const registry = await registryServing("2.0.0", release("2.0.0"));
  try {
    const env = { ...process.env, WELLACTUALLY_NPM_REGISTRY: registry.url };
    await rescue(root, env);
    expect(readRuntime().current).toBe("1.0.0");
    expect(JSON.parse(fs.readFileSync(rescueFile(), "utf8"))).toMatchObject({ channel: "latest", from: "1.0.0" });
    ageRescue(1);
    await rescue(root, env);
    expect(readRuntime().current).toBe("1.0.0");
    ageRescue(1.1);
    const { stdout } = await rescue(root, env);
    expect(stdout).toMatch(/Installed Well Actually 2.0.0 with the second updater/);
    expect(readRuntime()).toMatchObject({ current: "2.0.0", previous: "1.0.0" });
    expect(fs.existsSync(rescueFile())).toBe(false);
    expect(shim(root, "hook").version).toBe("2.0.0");
  } finally {
    registry.close();
  }
});

test("the second updater leaves a pin alone and refuses a release that does not match its integrity", async () => {
  const root = plugin();
  installTarball(release("1.0.0"), { pin: true });
  const registry = await registryServing("2.0.0", release("2.0.0"), `sha512-${crypto.createHash("sha512").update("other").digest("base64")}`);
  try {
    const env = { ...process.env, WELLACTUALLY_NPM_REGISTRY: registry.url };
    await rescue(root, env);
    expect(fs.existsSync(rescueFile())).toBe(false);
    installTarball(release("1.0.0"));
    await rescue(root, env);
    ageRescue(3);
    await expect(rescue(root, env)).rejects.toMatchObject({ stderr: expect.stringMatching(/rescue-update failed: the downloaded release does not match/) });
    expect(readRuntime().current).toBe("1.0.0");
    expect(fs.readdirSync(path.join(runtimeDir(), "versions")).filter(name => name.startsWith(".staging-"))).toEqual([]);
  } finally {
    registry.close();
  }
});

test("the second updater forgets a release once the first installed it", async () => {
  const root = plugin();
  installTarball(release("1.0.0"));
  const tarball = release("2.0.0");
  const registry = await registryServing("2.0.0", tarball);
  try {
    const env = { ...process.env, WELLACTUALLY_NPM_REGISTRY: registry.url };
    await rescue(root, env);
    expect(fs.existsSync(rescueFile())).toBe(true);
    installTarball(tarball);
    await rescue(root, env);
    expect(fs.existsSync(rescueFile())).toBe(false);
  } finally {
    registry.close();
  }
});

test("the second updater does not undo an install that finished while it downloaded", async () => {
  const root = plugin();
  installTarball(release("1.0.0"));
  const registry = await registryServing("1.1.0", release("1.1.0"), undefined, () => installTarball(release("1.2.0")));
  try {
    const env = { ...process.env, WELLACTUALLY_NPM_REGISTRY: registry.url };
    await rescue(root, env);
    ageRescue(3);
    await rescue(root, env);
    expect(readRuntime().current).toBe("1.2.0");
  } finally {
    registry.close();
  }
  // The first updater keeps to the same rule.
  expect(installTarball(release("1.3.0"), { auto: true, resolvedFrom: "1.0.0" })).toBeUndefined();
});

test("both updaters reinstall a current release whose files are gone, at once", async () => {
  const root = plugin();
  const tarball = release("2.0.0");
  installTarball(tarball);
  fs.rmSync(path.join(runtimeDir(), "versions/2.0.0/dist"), { recursive: true });
  const registry = await registryServing("2.0.0", tarball);
  try {
    await rescue(root, { ...process.env, WELLACTUALLY_NPM_REGISTRY: registry.url });
    expect(shim(root, "hook").version).toBe("2.0.0");
    fs.rmSync(path.join(runtimeDir(), "versions/2.0.0/dist"), { recursive: true });
    expect(await update({ registry: registry.url })).toMatch(/Installed Well Actually 2.0.0/);
    expect(shim(root, "hook").version).toBe("2.0.0");
  } finally {
    registry.close();
  }
});

test("the second updater's wait starts again on another channel", async () => {
  const root = plugin();
  installTarball(release("1.0.0"));
  const registry = await registryServing("2.0.0", release("2.0.0"));
  try {
    const env = { ...process.env, WELLACTUALLY_NPM_REGISTRY: registry.url };
    await rescue(root, env);
    ageRescue(3);
    fs.writeFileSync(rescueFile(), JSON.stringify({ ...JSON.parse(fs.readFileSync(rescueFile(), "utf8")), channel: "next" }));
    await rescue(root, env);
    expect(readRuntime().current).toBe("1.0.0");
  } finally {
    registry.close();
  }
});

test("the first hook of the day starts the second updater, which reaches the registry; the update-check switch keeps both off", async () => {
  const root = plugin();
  installTarball(release("1.0.0"));
  const registry = await registryServing("2.0.0", release("2.0.0"));
  try {
    await promisify(execFile)(process.execPath, [path.join(root, "shim.mjs"), "hook"], { env: { ...process.env, WELLACTUALLY_NPM_REGISTRY: registry.url } });
    for (let i = 0; i < 50 && !fs.existsSync(rescueFile()); i++) await new Promise(resolve => setTimeout(resolve, 100));
    expect(JSON.parse(fs.readFileSync(rescueFile(), "utf8"))).toMatchObject({ channel: "latest", from: "1.0.0" });
  } finally {
    registry.close();
  }
  for (const entry of fs.readdirSync(runtimeDir())) if (entry.includes("checked")) fs.rmSync(path.join(runtimeDir(), entry));
  execFileSync(process.execPath, [path.join(root, "shim.mjs"), "hook"], { env: { ...process.env, WELLACTUALLY_UPDATE_CHECK: "0" } });
  expect(fs.readdirSync(runtimeDir()).filter(entry => entry.includes("checked"))).toEqual([]);
});

test("a state.json that names a path instead of a version is ignored", () => {
  const root = plugin();
  fs.mkdirSync(runtimeDir(), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir(), "state.json"), JSON.stringify({ current: "..", previous: "../.." }));
  expect(shim(root, "hook").version).toBe("0.0.1");
});

test("the second updater's wait is not restarted by a run of quick releases, and works on a fresh home", async () => {
  const root = plugin();
  installTarball(release("1.0.0"));
  const registry = await registryServing("1.0.1", release("1.0.1"));
  try {
    const env = { ...process.env, WELLACTUALLY_NPM_REGISTRY: registry.url };
    await rescue(root, env);
    ageRescue(2.1);
    registry.serve("1.0.2", release("1.0.2"));
    await rescue(root, env);
    expect(readRuntime()).toMatchObject({ current: "1.0.2", previous: "1.0.0" });
    // Nothing under the home yet: the observation is still written.
    fs.rmSync(runtimeDir(), { recursive: true });
    await rescue(root, env);
    expect(fs.existsSync(rescueFile())).toBe(true);
  } finally {
    registry.close();
  }
});

test("the second updater follows a tag moved back, and leaves the runtime alone when auto-update is off", async () => {
  const root = plugin();
  installTarball(release("1.0.0"));
  installTarball(release("2.0.0"));
  const registry = await registryServing("1.0.0", release("1.0.0"));
  try {
    const env = { ...process.env, WELLACTUALLY_NPM_REGISTRY: registry.url };
    await rescue(root, { ...env, WELLACTUALLY_AUTO_UPDATE: "0" });
    expect(fs.existsSync(rescueFile())).toBe(false);
    await rescue(root, env);
    ageRescue(3);
    await rescue(root, env);
    expect(readRuntime()).toMatchObject({ current: "1.0.0", previous: "2.0.0" });
  } finally {
    registry.close();
  }
});
