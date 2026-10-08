#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readConfig, readCached, readLockfile, scaffold, switchedOff, switchPrinciple, writeConfig } from "@wellactually/core/node";
import {
  addLocal,
  principleHistory,
  probePrinciple,
  publishPrinciple,
  pullPrinciple,
  removeLocal,
  renderHistory,
  renderProbe,
  renderPull,
  renderReport,
  renderSwitch,
  renderTry,
  testPrinciple,
  tryPrinciple,
} from "./commands.ts";
import { logHookFailure, runHook } from "./hook.ts";
import { serveMcp } from "./mcp.ts";
import { finishDeviceLogin, logout, RegistryError, startDeviceLogin, sync, whoami } from "./registry.ts";

const HELP = `wellactually: author principles and run your advisory board

Authoring
  wellactually init <slug>              Create a principle directory that already passes its tests
  wellactually test [dir]               Build the principle and run its tests in the isolate
  wellactually try [dir] <file>         Show one file to the detector, as if the agent had written it
        --read                   ... as if the agent had only read it
        --prompt <text>          ... or a user message
        --command <text>         ... or a shell command
  wellactually probe <repo> [dir]       Run the detector over a repository and report the fire rate
  wellactually publish [dir]            Upload a private draft; a human releases it on the website
        -m, --message <text>     ... with a note on what changed, shown in the history
  wellactually pull <id>[@version] [dir] Download a principle's files to keep working on it
        --force                  ... replacing the files of an existing directory
  wellactually log <id>                 Show a principle's versions, what each changed and why

Your advisory board
  wellactually login [--registry <url>] Sign in through the browser
  wellactually logout
  wellactually whoami
  wellactually sync                     Download the advisory board you set up on the website
  wellactually list                     Show what the hook runs
  wellactually add <dir>                Put a local principle on this machine's advisory board
  wellactually remove <slug>            Take a local principle off again
  wellactually disable <id> [--global]  Switch a principle off in this project, or everywhere with --global
  wellactually enable <id> [--global]   Switch it on again
  wellactually stats [on|off]           Report how often each principle fired, as counts only. On by default

Integration
  wellactually hook                     Handle one Claude Code or Codex hook payload from stdin
  wellactually mcp                      Serve the authoring commands as an MCP server

Every authoring command takes --json.`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      read: { type: "boolean", default: false },
      draft: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      message: { type: "string", short: "m" },
      prompt: { type: "string" },
      command: { type: "string" },
      registry: { type: "string" },
      global: { type: "boolean", default: false },
    },
  });
  const print = (data: unknown, rendered: string): void => {
    console.log(values.json ? JSON.stringify(data, null, 2) : rendered);
  };

  switch (command) {
    case "init": {
      const slug = positionals[0];
      if (!slug) {
        console.error("usage: wellactually init <slug>");
        return 2;
      }
      const dir = scaffold(slug, process.cwd());
      console.log(`Created ${dir}\nNext: wellactually test ${slug}`);
      return 0;
    }
    case "test": {
      const result = await testPrinciple(positionals[0] ?? ".");
      print(result, renderReport(result));
      return result.report.ok ? 0 : 1;
    }
    case "try": {
      const hasText = values.prompt !== undefined || values.command !== undefined;
      const dir = positionals.length > (hasText ? 0 : 1) ? (positionals[0] ?? ".") : ".";
      const file = hasText ? undefined : positionals[positionals.length - 1];
      const result = await tryPrinciple(dir, { file, read: values.read, prompt: values.prompt, command: values.command });
      print(result, renderTry(result));
      return 0;
    }
    case "probe": {
      const repo = positionals[0];
      if (!repo) {
        console.error("usage: wellactually probe <repo> [dir]");
        return 2;
      }
      const report = await probePrinciple(positionals[1] ?? ".", repo);
      print(report, renderProbe(report));
      return report.ok ? 0 : 1;
    }
    case "publish": {
      const result = await publishPrinciple(positionals[0] ?? ".", values.message ?? "");
      const rendered = renderReport({ id: result.id, title: null, report: result.report });
      if (!result.accepted) {
        print(result, `The registry refused the draft.\n${rendered}`);
        return 1;
      }
      print(result, `${rendered}\nDraft version ${result.version} uploaded. Review and release it at ${result.url}`);
      return 0;
    }
    case "log": {
      const id = positionals[0];
      if (!id) {
        console.error("usage: wellactually log <expert/principle>");
        return 2;
      }
      const result = await principleHistory(id);
      print(result, renderHistory(result));
      return 0;
    }
    case "pull": {
      const id = positionals[0];
      if (!id) {
        console.error("usage: wellactually pull <expert/principle>[@version] [dir]");
        return 2;
      }
      const result = await pullPrinciple(id, positionals[1], values.force);
      print(result, renderPull(result));
      return 0;
    }
    case "login": {
      if (values.registry) {
        writeConfig({ ...readConfig(), registry: values.registry });
      }
      const start = await startDeviceLogin();
      console.log(`Open ${start.verification_url}\nand confirm the code ${start.user_code}`);
      const handle = await finishDeviceLogin(start);
      console.log(`Signed in as ${handle}. Run \`wellactually sync\` to download your advisory board.`);
      return 0;
    }
    case "logout":
      logout();
      console.log("Signed out.");
      return 0;
    case "whoami":
      console.log(`${await whoami()} on ${readConfig().registry}`);
      return 0;
    case "sync": {
      const result = await sync();
      const enabled = result.entries.filter((entry) => entry.enabled).length;
      print(
        result,
        `${result.entries.length} principles on your advisory board, ${enabled} enabled. Downloaded ${result.downloaded.length}, removed ${result.removed.length}.${result.reported > 0 ? ` Reported ${result.reported} detections.` : ""}`,
      );
      return 0;
    }
    case "stats": {
      const wanted = positionals[0];
      if (wanted === "on" || wanted === "off") {
        writeConfig({ ...readConfig(), stats: wanted === "on" });
      } else if (wanted !== undefined) {
        console.error("Usage: wellactually stats [on|off]");
        return 2;
      }
      console.log(
        readConfig().stats
          ? "Reporting is on: `wellactually sync` sends how often each principle fired, as a count per day. No file, prompt or evidence is sent."
          : "Reporting is off: nothing about what fires on this machine is sent.",
      );
      return 0;
    }
    case "list": {
      const lockfile = readLockfile();
      if (lockfile.entries.length === 0) {
        console.log("Your advisory board is empty. Add experts on the website and run `wellactually sync`, or `wellactually add <dir>`.");
        return 0;
      }
      const off = switchedOff(process.cwd());
      for (const entry of lockfile.entries) {
        const title = readCached(entry.hash)?.manifest.title ?? "(not downloaded, run `wellactually sync`)";
        const where = [...(entry.enabled ? [] : ["website"]), ...(off.get(entry.id) ?? [])];
        console.log(`${where.length === 0 ? "on " : "off"}  ${entry.id}@${entry.version}  ${title}${where.length > 0 ? `  (off: ${where.join(", ")})` : ""}`);
      }
      return 0;
    }
    case "disable":
    case "enable": {
      const id = positionals[0];
      if (!id) {
        console.error(`usage: wellactually ${command} <expert/principle> [--global]`);
        return 2;
      }
      const on = command === "enable";
      try {
        const result = switchPrinciple(id, on, values.global ? "global" : "project", process.cwd());
        print(result, renderSwitch(result, on));
        return 0;
      } catch (error) {
        console.error((error as Error).message);
        return 1;
      }
    }
    case "add": {
      const result = await addLocal(positionals[0] ?? ".");
      print(result, result.report.ok ? `${renderReport(result)}\nAdded ${result.id} to this machine's advisory board.` : renderReport(result));
      return result.report.ok ? 0 : 1;
    }
    case "remove": {
      const id = positionals[0];
      if (!id) {
        console.error("usage: wellactually remove <slug>");
        return 2;
      }
      if (!removeLocal(id)) {
        console.error(`No local principle "${id}" on the advisory board. Registry principles are removed on the website.`);
        return 1;
      }
      console.log(`Removed ${id}.`);
      return 0;
    }
    case "hook": {
      // A hook that crashes or hangs breaks the user's session, so it logs and exits clean instead.
      try {
        const out = await runHook(await readStdin());
        if (out) {
          console.log(out);
        }
      } catch (error) {
        logHookFailure(error);
        console.error(`wellactually hook failed, see ~/.wellactually/hook.log: ${(error as Error).message}`);
      }
      return 0;
    }
    case "mcp":
      await serveMcp();
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof RegistryError) {
      console.error(error.message);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  },
);
