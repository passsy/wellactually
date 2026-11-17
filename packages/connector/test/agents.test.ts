import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { eventsOf, type HookPayload } from "../src/hook/payload.ts";
import { Pending, adviceOf, contentBefore, nodeMissing, updateNoticeFor } from "../src/agents/bridge.ts";
import { opencodePayload } from "../src/agents/opencode.ts";
import { piPayload } from "../src/agents/pi.ts";

/**
 * OpenCode and pi report tool calls in their own shapes. Their plugins turn
 * each into the Claude Code payload `wellactually hook` reads, so the events
 * detectors see are the same in every agent. The tool inputs here are the
 * ones the agents sent in a real session.
 */
const cwd = "/repo";
const file = "class User {\n  late String name;\n}\n";
const disk = (absolute: string) => (absolute === "/repo/lib/user.dart" ? file : null);
const events = (payload: HookPayload | null) =>
  payload === null
    ? []
    : eventsOf(payload, disk).map((ctx) => ({
        event: ctx.event,
        path: ctx.file?.relativePath ?? null,
        text: ctx.file ? null : ctx.text,
        written: ctx.file?.written.map((line) => line.line) ?? null,
        isNew: ctx.file?.isNew ?? null,
      }));
const removed = (payload: HookPayload | null) => (payload === null ? [] : eventsOf(payload, disk).map((ctx) => ctx.file?.removed.map((line) => `${line.line}:${line.text}`)));
const before = "class User {\n  String name;\n  int age;\n}\n";

describe("OpenCode", () => {
  const call = (tool: string, input: Record<string, unknown>) => ({ tool, sessionID: "ses_1", callID: "call_1", input });

  test("a shell command is a command before it runs and its output after", () => {
    const shell = call("shell", { command: "git status" });
    expect(events(opencodePayload(shell, cwd))).toEqual([{ event: "command", path: null, text: "git status", written: null, isNew: null }]);
    expect(events(opencodePayload(shell, cwd, "On branch main\n"))).toEqual([{ event: "output", path: null, text: "On branch main\n", written: null, isNew: null }]);
  });

  test("OpenCode 1 calls its shell bash", () => {
    expect(events(opencodePayload(call("bash", { command: "ls" }), cwd))).toEqual([{ event: "command", path: null, text: "ls", written: null, isNew: null }]);
  });

  test("a new file from write is a new write of the whole file", () => {
    expect(events(opencodePayload(call("write", { path: "lib/user.dart", content: file }), cwd, "Created file", null))).toEqual([
      { event: "write", path: "lib/user.dart", text: null, written: [1, 2, 3, 4], isNew: true },
    ]);
  });

  test("an edit is a write of the lines it changed, with OpenCode 1's names too", () => {
    const expected = [{ event: "write", path: "lib/user.dart", text: null, written: [2], isNew: false }];
    expect(events(opencodePayload(call("edit", { path: "lib/user.dart", oldString: "x", newString: "  late String name;" }), cwd, "Edited"))).toEqual(expected);
    expect(events(opencodePayload(call("edit", { filePath: "lib/user.dart", oldString: "x", newString: "  late String name;" }), cwd, "Edited"))).toEqual(expected);
  });

  test("a write or an edit knows what it removed from the file as it was before", () => {
    expect(removed(opencodePayload(call("edit", { path: "lib/user.dart", oldString: "String name;", newString: "late String name;" }), cwd, "Edited", before))).toEqual([["2:  String name;", "3:  int age;"]]);
    expect(removed(opencodePayload(call("write", { path: "lib/user.dart", content: file }), cwd, "Wrote", before))).toEqual([["2:  String name;", "3:  int age;"]]);
    // Not known, as for a file too large to keep.
    expect(removed(opencodePayload(call("edit", { path: "lib/user.dart", oldString: "x", newString: "y" }), cwd, "Edited", undefined))).toEqual([[]]);
  });

  test("a read is a read", () => {
    expect(events(opencodePayload(call("read", { path: "lib/user.dart" }), cwd, "1: class User {"))).toEqual([
      { event: "read", path: "lib/user.dart", text: null, written: [], isNew: false },
    ]);
  });

  test("a patch is a write of the lines it adds", () => {
    const patchText = "*** Begin Patch\n*** Update File: lib/user.dart\n@@\n-  String name;\n+  late String name;\n*** End Patch";
    expect(events(opencodePayload(call("apply_patch", { patchText }), cwd, "Done"))).toEqual([{ event: "write", path: "lib/user.dart", text: null, written: [2], isNew: false }]);
  });

  test("a subagent's task is a prompt", () => {
    expect(events(opencodePayload(call("task", { prompt: "refactor with riverpod", description: "x" }), cwd))).toEqual([
      { event: "prompt", path: null, text: "refactor with riverpod", written: null, isNew: null },
    ]);
  });

  test("tools no detector looks at have no payload", () => {
    expect(opencodePayload(call("glob", { pattern: "**/*.dart" }), cwd, "lib/user.dart")).toBeNull();
    expect(opencodePayload(call("read", { path: "lib/user.dart" }), cwd)).toBeNull();
  });
});

describe("pi", () => {
  const base = { session_id: "s", cwd };
  const call = (toolName: string, input: Record<string, unknown>) => ({ toolName, toolCallId: "t1", input });

  test("bash is a command before it runs and its output after", () => {
    expect(events(piPayload(call("bash", { command: "git status" }), base))).toEqual([{ event: "command", path: null, text: "git status", written: null, isNew: null }]);
    expect(events(piPayload(call("bash", { command: "git status" }), base, "On branch main"))).toEqual([
      { event: "output", path: null, text: "On branch main", written: null, isNew: null },
    ]);
  });

  test("an edit knows what it removed from the file as it was before", () => {
    const edit = call("edit", { path: "lib/user.dart", edits: [{ oldText: "String name;", newText: "late String name;" }] });
    expect(removed(piPayload(edit, base, "Edited", before))).toEqual([["2:  String name;", "3:  int age;"]]);
  });

  test("an edit is a write of the lines its edits wrote", () => {
    const edit = call("edit", { path: "lib/user.dart", edits: [{ oldText: "String name;", newText: "late String name;" }] });
    expect(events(piPayload(edit, base, "Edited"))).toEqual([{ event: "write", path: "lib/user.dart", text: null, written: [2], isNew: false }]);
  });

  test("a path pi was given with @ is the file", () => {
    expect(events(piPayload(call("write", { path: "@lib/user.dart", content: file }), base, "Wrote", null))).toEqual([
      { event: "write", path: "lib/user.dart", text: null, written: [1, 2, 3, 4], isNew: true },
    ]);
  });
});

describe("the hook's answer", () => {
  test("the advice is the additional context", () => {
    expect(adviceOf(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "<wellactually>" } }))).toBe("<wellactually>");
    expect(adviceOf("")).toBe("");
    expect(adviceOf("not json")).toBe("");
  });

  test("advice from before a call waits for its result, once", () => {
    const pending = new Pending();
    pending.add("c1", "first");
    pending.add("c1", "");
    pending.add("c1", "second");
    expect(pending.take("c1")).toBe("first\n\nsecond");
    expect(pending.take("c1")).toBe("");
  });
});

describe("without Node", () => {
  test("the plugin tells the user to install it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-"));
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(path.join(root, "dist", "wellactually.mjs"), "");
    const before = process.env.PATH;
    process.env.PATH = path.join(root, "empty");
    try {
      expect(await updateNoticeFor("opencode", root)).toBe(nodeMissing("opencode"));
    } finally {
      process.env.PATH = before;
      fs.rmSync(root, { recursive: true });
    }
  });

  test("names the agent to restart", () => {
    expect(nodeMissing("opencode-1")).toContain("restart OpenCode.");
    expect(nodeMissing("pi")).toContain("restart pi.");
  });
});

describe("the file before a tool changes it", () => {
  test("is its text, null when it is not there, and unknown when it is no text", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-before-"));
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
    fs.writeFileSync(path.join(dir, "logo.png"), "\0PNG");
    expect(contentBefore(path.join(dir, "a.txt"))).toBe("a\n");
    expect(contentBefore(path.join(dir, "missing.txt"))).toBeNull();
    expect(contentBefore(path.join(dir, "logo.png"))).toBeUndefined();
    expect(contentBefore(dir)).toBeUndefined();
  });
});
