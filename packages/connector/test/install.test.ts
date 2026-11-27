import { expect, test, vi } from "vitest";
import { HOSTS, install } from "../src/install.ts";

test("install adds the plugin to every agent found, updates what is already installed, and skips the rest", () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const ran: string[] = [];
  // Claude Code has the plugin already, so its install fails and the update runs; pi fails outright.
  const exec = (bin: string, args: string[]) => {
    ran.push(`${bin} ${args.join(" ")}`);
    return !(bin === "claude" && args[1] === "install") && bin !== "pi";
  };
  const result = install(HOSTS, exec, (bin) => bin !== "opencode");
  expect(result.installed.map((host) => host.name)).toEqual(["Claude Code", "Codex"]);
  expect(result.failed.map((host) => host.name)).toEqual(["pi"]);
  expect(result.missing.map((host) => host.name)).toEqual(["OpenCode"]);
  expect(ran).toEqual([
    "claude plugin marketplace add passsy/wellactually",
    "claude plugin marketplace update wellactually",
    "claude plugin install wellactually@wellactually",
    "claude plugin update wellactually@wellactually",
    "codex plugin marketplace add passsy/wellactually",
    "codex plugin marketplace upgrade wellactually",
    "codex plugin add wellactually@wellactually",
    "pi install npm:wellactually",
    "pi update npm:wellactually",
  ]);
});
