import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { HOSTS, install, which } from "../src/install.ts";

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  home = fs.mkdtempSync(path.join(os.tmpdir(), "wa-install-"));
  env = { CLAUDE_CONFIG_DIR: path.join(home, "claude"), XDG_CONFIG_HOME: path.join(home, "config"), PI_CODING_AGENT_DIR: path.join(home, "pi") };
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function write(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

/** Records every command and fails the ones `fails` names. */
function recorder(fails: string[] = []) {
  const ran: string[] = [];
  const exec = (file: string, args: string[]) => {
    const line = `${file} ${args.join(" ")}`;
    ran.push(line);
    return !fails.includes(line);
  };
  return { ran, exec };
}

test("a fresh machine gets the plugin installed in every agent found", () => {
  const { ran, exec } = recorder();
  const results = install(HOSTS, exec, (bin) => (bin === "opencode" ? undefined : `/bin/${bin}`), env);
  expect(results.map(({ host, outcome }) => [host.name, outcome.status])).toEqual([["Claude Code", "installed"], ["Codex", "installed"], ["OpenCode", "missing"], ["pi", "installed"]]);
  expect(ran).toEqual([
    "/bin/claude plugin marketplace add passsy/wellactually",
    "/bin/claude plugin marketplace update wellactually",
    "/bin/claude plugin install wellactually@wellactually --scope user",
    "/bin/codex plugin marketplace add passsy/wellactually",
    "/bin/codex plugin marketplace upgrade wellactually",
    "/bin/codex plugin add wellactually@wellactually",
    "/bin/pi install npm:wellactually",
  ]);
});

test("installed plugins are updated or kept, and pinned ones stay as they are", () => {
  write(path.join(env.CLAUDE_CONFIG_DIR as string, "plugins/installed_plugins.json"), { plugins: { "wellactually@wellactually": [{ scope: "user" }] } });
  write(path.join(env.XDG_CONFIG_HOME as string, "opencode/opencode.json"), { plugins: ["other", "wellactually"] });
  write(path.join(env.PI_CODING_AGENT_DIR as string, "settings.json"), { packages: [{ source: "npm:wellactually@0.13.1" }] });
  const { ran, exec } = recorder();
  const results = install(HOSTS, exec, (bin) => (bin === "codex" ? undefined : `/bin/${bin}`), env);
  expect(results.map(({ outcome }) => outcome)).toEqual([
    { status: "updated" },
    { status: "missing" },
    { status: "present" },
    { status: "pinned", entry: "npm:wellactually@0.13.1", file: path.join(env.PI_CODING_AGENT_DIR as string, "settings.json") },
  ]);
  expect(ran).toContain("/bin/claude plugin update wellactually@wellactually --scope user");
  expect(ran.filter((line) => line.startsWith("/bin/pi"))).toEqual([]);
});

test("which finds a launcher on the PATH, never in the current folder, and with Windows' extensions", () => {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), "", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "codex"), "", { mode: 0o644 });
  fs.writeFileSync(path.join(bin, "pi.CMD"), "");
  expect(which("claude", { PATH: `.:${bin}` }, "darwin")).toBe(path.join(bin, "claude"));
  expect(which("codex", { PATH: bin }, "darwin")).toBeUndefined();
  expect(which("pi", { Path: `.;${bin}`, PATHEXT: ".EXE;.CMD" }, "win32")).toBe(path.join(bin, "pi.CMD"));
  const cwd = process.cwd();
  try {
    process.chdir(bin);
    expect(which("claude", { PATH: "." }, "darwin")).toBeUndefined();
  } finally {
    process.chdir(cwd);
  }
});

test("a marketplace that cannot be refreshed fails the agent instead of installing from a stale catalog", () => {
  const { ran, exec } = recorder(["/bin/claude plugin marketplace update wellactually"]);
  const [claude] = install(HOSTS.slice(0, 1), exec, (bin) => `/bin/${bin}`, env);
  expect(claude?.outcome).toEqual({ status: "failed" });
  expect(ran.some((line) => line.includes("plugin install"))).toBe(false);
});
