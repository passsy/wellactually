// Exercise the packed product, outside this checkout and without dependencies or
// lifecycle scripts. Source-level tests cannot catch missing assets/entrypoints.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { artifacts: { type: "string" }, "local-marketplace": { type: "string" } } });
const artifacts = values.artifacts ? path.resolve(values.artifacts) : path.join(root, ".artifacts");
const packed = JSON.parse(fs.readFileSync(path.join(artifacts, "pack.json"), "utf8"));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-package-"));
const repo = path.join(temp, "repo");
fs.mkdirSync(repo);
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const freePort = () => new Promise((resolve, reject) => {
  const socket = net.createServer();
  socket.once("error", reject);
  socket.listen(0, "127.0.0.1", () => { const { port } = socket.address(); socket.close(() => resolve(port)); });
});
const env = {
  PATH: process.env.PATH, CI: "1", WELLACTUALLY_UPDATE_CHECK: "0",
  WELLACTUALLY_HOOK_LOG: "0", WELLACTUALLY_GIT: "0",
  WELLACTUALLY_HOME: path.join(temp, "advice"), WELLACTUALLY_FINDINGS_HOME: path.join(temp, "findings"),
};
const run = (args, input) => execFileSync(process.execPath, args, { cwd: temp, env, encoding: "utf8", input, timeout: 30_000 });
try {
  execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", path.join(artifacts, packed.filename)], { cwd: temp, encoding: "utf8", timeout: 30_000 });
  const installed = path.join(temp, "node_modules/wellactually");
  const manifest = read(path.join(installed, "package.json"));
  assert.equal(manifest.version, packed.version);
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.workspaces, undefined);
  if (values["local-marketplace"]) {
    const marketplace = path.resolve(values["local-marketplace"]);
    const catalog = read(path.join(marketplace, ".claude-plugin/marketplace.json"));
    const entry = catalog.plugins.find(plugin => plugin.name === "wellactually");
    assert.equal(entry.version, manifest.version);
    const local = path.resolve(marketplace, entry.source);
    assert(local.startsWith(`${marketplace}${path.sep}`));
    assert.equal(read(path.join(local, "package.json")).private, true);
    assert.equal(manifest.private, true);
    const { prepareLocalPackage } = await import("./install-local.mjs");
    assert.throws(() => prepareLocalPackage({ destination: marketplace, version: manifest.version, build: false }), /already exists/);
    assert.equal(read(path.join(local, "package.json")).version, manifest.version);
    const publicPackage = read(path.join(root, ".artifacts/package/package.json"));
    assert.notEqual(publicPackage.private, true, "Local preparation must not replace the release artifact");
    console.log("Local marketplace: private package, immutable version and isolated release output passed");
  }
  for (const host of ["root", "opencode"]) {
    const source = path.join(artifacts, "git-compat", host);
    const bridge = path.join(temp, `git-${host}`);
    fs.cpSync(source, bridge, { recursive: true });
    const proposed = read(path.join(bridge, "package.json"));
    assert.equal(proposed.dependencies["wellactually-runtime"], `npm:wellactually@${manifest.version}`);
    // Test the exact wrappers against this tarball before it is published. The
    // fixture omits monorepo development workspaces and substitutes a local
    // archive for the registry alias; registry installation remains a gate.
    fs.writeFileSync(path.join(bridge, "package.json"), JSON.stringify({ name: `wellactually-git-${host}-test`, private: true, type: "module", dependencies: { "wellactually-runtime": `file:${path.join(artifacts, packed.filename)}` } }));
    execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"], { cwd: bridge, encoding: "utf8", timeout: 30_000 });
    if (host === "root") {
      assert.equal(typeof (await import(pathToFileURL(path.join(bridge, proposed.pi.extensions[0])))).default, "function");
      assert(fs.existsSync(path.join(bridge, proposed.pi.skills[0], "wellactually-review/SKILL.md")));
    } else {
      assert.equal((await import(pathToFileURL(path.join(bridge, "index.mjs")))).default.id, "wellactually");
      assert.equal((await import(pathToFileURL(path.join(bridge, "tui.mjs")))).default.id, "wellactually");
    }
  }
  console.log("Legacy Git adapters: shared prebuilt dependency and skill paths passed");
  assert.equal(packed.files.filter(({ path }) => path.endsWith("wellactually.mjs")).length, 1);
  assert.equal(packed.files.filter(({ path }) => path.endsWith("dist/review.mjs")).length, 1);
  assert(!packed.files.some(({ path }) => /(^|\/)(node_modules|\.well-actually|\.git)\/|\.(ts|mts|map)$/.test(path)));
  assert.match(run([path.join(installed, manifest.bin.wellactually), "--help"]), /advisory board/);
  for (const skill of ["skills/review", "opencode/skills/wellactually-review"]) {
    assert.match(run([path.join(installed, skill, "scripts/review.mjs"), "--help"]), /Review preparation/);
  }
  // Preparation must discover its step files from the installed helper path.
  fs.writeFileSync(path.join(repo, "sample.ts"), "export const answer = 42;\n");
  const prepared = JSON.parse(run([path.join(installed, "skills/review/scripts/review.mjs"), "--root", repo, "--files", "sample.ts", "--out", path.join(temp, "review"), "--json"]));
  assert(prepared);
  assert(fs.existsSync(path.join(temp, "review/steps/9_finding-writing.md")));

  const hook = read(path.join(installed, "hooks/hooks.json"));
  assert.equal(Object.keys(hook.hooks).length, 6);
  for (const entries of Object.values(hook.hooks)) for (const { hooks } of entries) for (const item of hooks) {
    assert(item.command.includes("${CLAUDE_PLUGIN_ROOT}/dist/wellactually-hook.mjs"));
  }
  run([path.join(installed, "dist/wellactually-hook.mjs")], JSON.stringify({ hook_event_name: "SessionEnd", session_id: "packed", cwd: temp }));

  for (const host of ["claude", "codex", "opencode"]) {
    let command;
    if (host === "claude") {
      const plugin = read(path.join(installed, ".claude-plugin/plugin.json"));
      assert.equal(plugin.version, manifest.version);
      command = plugin.mcpServers.wellactually.args.map(arg => arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", installed));
    } else if (host === "codex") {
      const plugin = read(path.join(installed, ".codex-plugin/plugin.json"));
      assert.equal(plugin.version, manifest.version);
      command = read(path.join(installed, plugin.mcpServers)).mcpServers.wellactually.args;
    } else {
      const { default: adapter } = await import(pathToFileURL(path.join(installed, manifest.exports["."])));
      const skills = [];
      const dispose = await adapter.setup({
        location: { directory: temp },
        mcp: { async transform(fn) { fn({ set(name, config) { assert.equal(name, "wellactually"); command = config.command.slice(1); } }); } },
        skill: { async transform(fn) { fn({ get() {}, add(skill) { skills.push(skill); } }); } },
        shell: { async hook() {} }, tool: { async hook() {} }, session: { async hook() {} },
        event: { async *subscribe() {} },
      });
      assert(skills.some(skill => skill.name === "wellactually-review" && fs.realpathSync(skill.path).startsWith(fs.realpathSync(installed))));
      dispose();
      assert.equal(typeof (await import(pathToFileURL(path.join(installed, manifest.exports["./tui"])))) .default.setup, "function");
    }
    const port = await freePort();
    const client = new Client({ name: "packed-artifact-test", version: "1" }, { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: command, cwd: installed, env: { ...env, WELLACTUALLY_REVIEW_HOST: host, WELLACTUALLY_REVIEW_PORT: String(port) } }));
      const tools = await client.listTools();
      const startTool = tools.tools.find(tool => tool.name === "start_review");
      assert(startTool);
      const started = await client.callTool({ name: "start_review", arguments: { repo, target: `packed-${host}` } });
      assert(!started.isError, JSON.stringify(started.content));
      if (host === "claude") {
        assert(tools.tools.every(tool => !tool._meta?.ui), "Claude must not advertise inline card tools");
        assert.equal(started.structuredContent, undefined);
        assert.equal(JSON.parse(started.content.find(item => item.type === "text").text).reviewCard.delivery, "disabled");
        await assert.rejects(client.readResource({ uri: "ui://wellactually/review-card.html" }));
        const status = await client.callTool({ name: "review_status", arguments: { repo, target: `packed-${host}` } });
        assert(!status.isError);
        assert.equal(status.structuredContent, undefined);
      } else {
        const resource = await client.readResource({ uri: startTool._meta.ui.resourceUri });
        assert(resource.contents[0].text.includes("<html"));
      }
      const created = await client.callTool({ name: "create_finding", arguments: { repo, target: `packed-${host}`, finding: { title: "Packed finding", description: "A packaging probe.", priority: "p3" } } });
      assert(!created.isError, JSON.stringify(created.content));
      const finding = JSON.parse(created.content.find(item => item.type === "text").text);
      for (let index = 0; index < 2; index++) {
        const occurrence = await client.callTool({ name: "create_occurrence", arguments: { repo, target: `packed-${host}`, occurrence: { findingId: finding.id, locations: [{ file: "sample.ts", line: 1 }] } } });
        assert(!occurrence.isError, JSON.stringify(occurrence.content));
      }
      const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
      assert.equal(health.version, manifest.version);
      const icon = await fetch(`http://127.0.0.1:${port}/icon-32.png`);
      assert.equal(icon.headers.get("content-type"), "image/png");
      assert(Buffer.from(await icon.arrayBuffer()).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
      const inbox = await (await fetch(`http://127.0.0.1:${port}/?repo=${encodeURIComponent(repo)}&target=packed-${host}`)).text();
      assert(inbox.includes("<html"));
      console.log(`${host}: installed manifest/adapter, MCP, finding creation, ${host === "claude" ? "no inline card" : "card"} and inbox passed`);
    } finally { await client.close(); }
  }

  // pi discovers its adapter using the package.json contract. Initializing it
  // must register tools from the installed server, not silently lose the MCP.
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  previous.set("WELLACTUALLY_REVIEW_PORT", process.env.WELLACTUALLY_REVIEW_PORT);
  previous.set("CLAUDE_PLUGIN_ROOT", process.env.CLAUDE_PLUGIN_ROOT);
  Object.assign(process.env, env, { WELLACTUALLY_REVIEW_PORT: String(await freePort()) });
  const shutdown = [];
  try {
    const { default: adapter } = await import(pathToFileURL(path.join(installed, manifest.pi.extensions[0])));
    const tools = [];
    await adapter({ on(event, fn) { if (event === "session_shutdown") shutdown.push(fn); }, registerTool(tool) { tools.push(tool); } });
    assert(tools.some(tool => tool.name === "wellactually_start_review"));
    assert(fs.existsSync(path.join(installed, manifest.pi.skills[0], "wellactually-review/SKILL.md")));
    console.log("pi: package discovery, adapter initialization and MCP tool registration passed");
  } finally {
    for (const fn of shutdown) await fn({}, { cwd: repo, sessionManager: { getSessionId: () => "package-test", getSessionFile: () => undefined } });
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  console.log(`Packed artifact passed: ${manifest.name}@${manifest.version} (${packed.size} bytes compressed)`);
} finally { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
