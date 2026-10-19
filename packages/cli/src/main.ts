#!/usr/bin/env node
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { isMainThread } from "node:worker_threads";
import { approvalKey, describeReview, type PackageInfo } from "@wellactually/core/node";
import { scaffold } from "./board/files.ts";
import { boardHome, readConfig, readCached, readLockfile, writeConfig } from "./board/board.ts";
import { serveDetectors } from "./board/pool.ts";
import { switchedOff, switchPrinciple } from "./board/switches.ts";
import {
  addLocal,
  ApprovalError,
  changeVisibility,
  principleHistory,
  probePrinciple,
  publishPrinciple,
  pullPrinciple,
  showPrinciple,
  renderShow,
  releasePrinciple,
  removeLocal,
  renderHistory,
  renderProbe,
  renderPublished,
  renderPull,
  renderRelease,
  renderVisibility,
  renderReport,
  renderRepositorySync,
  renderSwitch,
  renderSync,
  renderTry,
  syncRepo,
  testPrinciple,
  tryPrinciple,
} from "./commands.ts";
import { logHookFailure, runHook, startInBackground } from "./hook/hook.ts";
import { type HookLogEntry, scheduleHookLog, writeHookLogFromStdin } from "./hook/hook-log.ts";
import { serveMcp } from "./mcp.ts";
import { type Agent, checkForUpdate, updateNotice } from "./update.ts";
import { finishDeviceLogin, logout, RegistryError, reportDetections, startDeviceLogin, sync, whoami, type DraftResult } from "./registry/client.ts";

const HELP = `wellactually: author principles and run your advisory board

Authoring
  wellactually init <slug>              Create a principle directory that already passes its tests
  wellactually test [dir]               Build the principle and run its tests in the isolate
  wellactually try [dir] <file>         Show one file to the detector, as if the agent had written it
        --read                   ... as if the agent had only read it
        --prompt <text>          ... or a user message
        --command <text>         ... or a shell command
        --output <text>          ... or what a command printed, with --command naming it
  wellactually probe <repo> [dir]       Run the detector over a repository and report the fire rate
  wellactually publish [dir]            Upload and release the principle's next revision
        --approve <name@version> ... with a package whose licence needs your approval. Repeat it for each
        --visibility <public|private> ... and set who can see it
  wellactually release <id>             Release a principle's waiting draft
  wellactually visibility <id> <public|private> Set who can see one of your principles
  wellactually pull <id>[@revision] [dir] Download a principle's files to keep working on it
        --force                  ... replacing the files of an existing directory
  wellactually log <id>                 Show a principle's revisions and the files each changed
  wellactually show <id|link>           Print a principle's advice, author, tags and visibility
  wellactually sync-repo <owner/repo>   Have the registry read a connected GitHub repository now

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
  wellactually hook                     Handle one agent hook payload from stdin
  wellactually mcp                      Serve the authoring commands as an MCP server
  wellactually update-notice --agent <opencode|opencode-1|pi> Print what to tell the user about a newer release
  wellactually check-update             Look up the newest release on GitHub

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
      approve: { type: "string", multiple: true },
      visibility: { type: "string" },
      prompt: { type: "string" },
      command: { type: "string" },
      output: { type: "string" },
      registry: { type: "string" },
      global: { type: "boolean", default: false },
      agent: { type: "string" },
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
      const result = await tryPrinciple(dir, { file, read: values.read, prompt: values.prompt, command: values.command, output: values.output });
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
      // Only a person at a terminal can be asked. A script names what it approves with --approve.
      let confirm: ((info: PackageInfo) => Promise<boolean>) | undefined;
      if (process.stdin.isTTY && process.stdout.isTTY && !values.json) {
        confirm = async (info) => {
          const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
          console.log(`${approvalKey(info)} goes into the detector, and ${describeReview(info)}.`);
          console.log("Everyone who uses the principle gets its code. A licence like this can ask more of you than passing on its text.");
          const answer = await terminal.question("Publish the principle with it? [y/N] ");
          terminal.close();
          return /^y(es)?$/i.test(answer.trim());
        };
      }
      const visibility = values.visibility;
      if (visibility !== undefined && visibility !== "public" && visibility !== "private") {
        console.error("--visibility is public or private.");
        return 2;
      }
      let result: DraftResult;
      try {
        result = await publishPrinciple(positionals[0] ?? ".", { approved: values.approve ?? [], confirm, visibility });
      } catch (error) {
        if (error instanceof ApprovalError) {
          console.error(error.message);
          return 1;
        }
        throw error;
      }
      const rendered = renderReport({ id: result.id, title: null, report: result.report });
      if (!result.accepted) {
        print(result, `The registry refused the upload.\n${rendered}`);
        return 1;
      }
      print(result, `${rendered}\n${renderPublished(result)}`);
      return 0;
    }
    case "visibility": {
      const [id, visibility] = positionals;
      if (!id || !visibility) {
        console.error("usage: wellactually visibility <id> <public|private>");
        return 2;
      }
      const result = await changeVisibility(id, visibility);
      print(result, renderVisibility(result));
      return 0;
    }
    case "release": {
      const id = positionals[0];
      if (!id) {
        console.error("usage: wellactually release <id>");
        return 2;
      }
      const result = await releasePrinciple(id);
      print(result, renderRelease(result));
      return 0;
    }
    case "sync-repo": {
      const name = positionals[0];
      if (!name) {
        console.error("usage: wellactually sync-repo <owner/repo>");
        return 2;
      }
      const result = await syncRepo(name);
      print(result, renderRepositorySync(result));
      return result.principles.some((item) => item.status === "failed") ? 1 : 0;
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
    case "show": {
      const reference = positionals[0];
      if (!reference) {
        console.error("usage: wellactually show <expert/principle[@revision] | principle | link>");
        return 2;
      }
      const result = await showPrinciple(reference);
      print(result, renderShow(result));
      return 0;
    }
    case "pull": {
      const id = positionals[0];
      if (!id) {
        console.error("usage: wellactually pull <expert/principle>[@revision] [dir]");
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
      console.log(`Signed in as ${handle}.`);
      // The advisory board comes down right away, so the next session does not have to wait for its own sync.
      try {
        const result = await sync();
        print(result, renderSync(result));
      } catch (error) {
        console.log(`Could not download your advisory board yet: ${error instanceof Error ? error.message : String(error)}`);
        console.log("Run `wellactually sync` to try again. The next session also syncs on its own.");
      }
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
      print(result, renderSync(result));
      return 0;
    }
    case "check-update":
      // Started in the background at session start, at most once a day.
      console.log(`The newest release is ${(await checkForUpdate()) ?? "unknown"}.`);
      return 0;
    case "update-notice": {
      // The OpenCode and pi plugins show this where their agent shows notices.
      const agent = values.agent;
      if (agent !== "opencode" && agent !== "opencode-1" && agent !== "pi") {
        console.error("usage: wellactually update-notice --agent <opencode|opencode-1|pi>");
        return 2;
      }
      // The plugin's folder, above dist/ where this command is, which an OpenCode 1 user pulls in.
      const update = updateNotice(agent satisfies Agent, undefined, undefined, path.resolve(path.dirname(process.argv[1] as string), ".."));
      if (update.stale) {
        startInBackground("check-update");
      }
      if (update.text) {
        console.log(update.text);
      }
      return 0;
    }
    case "report-detections":
      // Started by the hook in the background. A sync sends them as well.
      console.log(`Reported ${await reportDetections()} detections.`);
      return 0;
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
          ? "Reporting is on: every few minutes, the hook sends how often each principle fired, as a count per day. No file, prompt or finding is sent."
          : "Reporting is off: nothing about what fires on this machine is sent.",
      );
      return 0;
    }
    case "list": {
      const lockfile = readLockfile();
      if (lockfile.entries.length === 0) {
        console.log("Your advisory board is empty. Follow experts on the website and run `wellactually sync`, or `wellactually add <dir>`.");
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
      const started = performance.now();
      const log: HookLogEntry = { time: new Date().toISOString(), hook: "", events: [], shown: 0, ms: 0 };
      try {
        const out = await runHook(await readStdin(), log);
        if (out) {
          console.log(out);
        }
        log.shown = out.length;
      } catch (error) {
        logHookFailure(error);
        log.note = `failed: ${(error as Error).message}`;
        console.error(`wellactually hook failed, see ~/.wellactually/hook.log: ${(error as Error).message}`);
      }
      log.ms = Math.round(performance.now() - started);
      // Written by another process once this one has answered, so the agent never waits for it.
      if (process.env.WELLACTUALLY_HOOK_LOG !== "0") {
        scheduleHookLog(path.join(boardHome(), "logs"), log);
      }
      return 0;
    }
    case "hook-log": {
      // What the hook starts when the small writer script is not beside it, as in a checkout.
      await writeHookLogFromStdin(positionals[0] as string);
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

// The hook starts this same file again as worker threads, to run detectors in parallel.
if (isMainThread) {
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
} else {
  void serveDetectors();
}
