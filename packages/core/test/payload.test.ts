import { describe, expect, test } from "vitest";
import { eventsOf, type HookPayload } from "../src/node.ts";

/**
 * The payload shapes are the ones Claude Code and Codex send to a hook.
 * A principle's tests never see them: they start from the events checked here.
 */
const cwd = "/repo";
const disk = (files: Record<string, string>) => (absolute: string) => files[absolute] ?? null;
const summary = (payload: HookPayload, files: Record<string, string> = {}) =>
  eventsOf({ cwd, session_id: "s", ...payload }, disk(files)).map((ctx) => ({
    event: ctx.event,
    path: ctx.file?.path ?? null,
    text: ctx.text,
    written: ctx.file?.written.map((line) => line.line) ?? null,
  }));

const legacy = "late User user;\nint retries = 3;\n";

describe("Claude Code payloads", () => {
  test("a prompt is a prompt event", () => {
    expect(summary({ hook_event_name: "UserPromptSubmit", prompt: "add a late field" })).toEqual([{ event: "prompt", path: null, text: "add a late field", written: null }]);
  });

  test("a Bash call is a command event before it runs", () => {
    const payload = { tool_name: "Bash", tool_input: { command: "git status" } };
    expect(summary({ hook_event_name: "PreToolUse", ...payload })).toEqual([{ event: "command", path: null, text: "git status", written: null }]);
    expect(summary({ hook_event_name: "PostToolUse", ...payload })).toEqual([]);
  });

  test("Write counts every line as written", () => {
    const payload = { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/repo/lib/a.dart", content: legacy } };
    expect(summary(payload, { "/repo/lib/a.dart": legacy })).toEqual([{ event: "write", path: "lib/a.dart", text: legacy, written: [1, 2, 3] }]);
  });

  test("Edit counts only the replacement as written", () => {
    const payload = { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "lib/a.dart", new_string: "int retries = 3;" } };
    expect(summary(payload, { "/repo/lib/a.dart": legacy })).toEqual([{ event: "write", path: "lib/a.dart", text: legacy, written: [2] }]);
  });

  test("MultiEdit counts every replacement", () => {
    const payload = {
      hook_event_name: "PostToolUse",
      tool_name: "MultiEdit",
      tool_input: { file_path: "lib/a.dart", edits: [{ new_string: "int retries = 3;" }, { new_string: "late User user;" }] },
    };
    expect(summary(payload, { "/repo/lib/a.dart": legacy })[0]?.written).toEqual([1, 2]);
  });

  test("Read is a read event with nothing written", () => {
    const payload = { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "lib/a.dart" } };
    expect(summary(payload, { "/repo/lib/a.dart": legacy })).toEqual([{ event: "read", path: "lib/a.dart", text: legacy, written: [] }]);
  });

  test("a file that cannot be read is no event", () => {
    expect(summary({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "lib/gone.dart", new_string: "x" } })).toEqual([]);
  });
});

describe("Codex payloads", () => {
  const patch = (body: string) => ({ hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n${body}\n*** End Patch` } });

  test("exec_command is a command event", () => {
    expect(summary({ hook_event_name: "PreToolUse", tool_name: "exec_command", tool_input: { cmd: "git status" } })).toEqual([
      { event: "command", path: null, text: "git status", written: null },
    ]);
  });

  test("a patch counts only its added lines as written", () => {
    const body = "*** Update File: lib/a.dart\n@@\n late User user;\n-int retries = 1;\n+int retries = 3;";
    expect(summary(patch(body), { "/repo/lib/a.dart": legacy })).toEqual([{ event: "write", path: "lib/a.dart", text: legacy, written: [2] }]);
  });

  test("a patch that only removes lines is no event", () => {
    expect(summary(patch("*** Update File: lib/a.dart\n@@\n-int old = 1;"), { "/repo/lib/a.dart": legacy })).toEqual([]);
  });

  test("a patch over several files is one event per file", () => {
    const body = ["*** Update File: lib/a.dart", "@@", "+int retries = 3;", "*** Add File: lib/b.dart", "+final b = 1;", "*** Delete File: lib/c.dart"].join("\n");
    expect(summary(patch(body), { "/repo/lib/a.dart": legacy, "/repo/lib/b.dart": "final b = 1;\n" })).toEqual([
      { event: "write", path: "lib/a.dart", text: legacy, written: [2] },
      { event: "write", path: "lib/b.dart", text: "final b = 1;\n", written: [1] },
    ]);
  });

  test("a moved file is judged where it ends up", () => {
    const body = "*** Update File: lib/a.dart\n*** Move to: lib/moved.dart\n@@\n+int retries = 3;";
    expect(summary(patch(body), { "/repo/lib/moved.dart": legacy })[0]?.path).toBe("lib/moved.dart");
  });

  test("a new file that is not on disk is taken from the patch", () => {
    expect(summary(patch("*** Add File: lib/b.dart\n+final b = 1;\n+final c = 2;"))).toEqual([
      { event: "write", path: "lib/b.dart", text: "final b = 1;\nfinal c = 2;", written: [1, 2] },
    ]);
  });
});
