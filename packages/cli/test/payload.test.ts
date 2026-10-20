import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { eventsOf, type HookPayload } from "../src/hook/payload.ts";

/**
 * The payload shapes are the ones Claude Code and Codex send to a hook.
 * A principle's tests never see them: they start from the events checked here.
 */
const cwd = "/repo";
const disk = (files: Record<string, string>) => (absolute: string) => files[absolute] ?? null;
const summary = (payload: HookPayload, files: Record<string, string> = {}) =>
  eventsOf({ cwd, session_id: "s", ...payload }, disk(files)).map((ctx) => ({
    event: ctx.event,
    path: ctx.file?.relativePath ?? null,
    text: ctx.text,
    written: ctx.file?.written.map((line) => line.line) ?? null,
  }));

const legacy = "late User user;\nint retries = 3;\n";

/** The file events of a payload with the lines removed from each, given what the files were before. */
const removals = (payload: HookPayload, files: Record<string, string>, before: Record<string, string> = {}) =>
  eventsOf({ cwd, session_id: "s", ...payload }, disk(files), undefined, disk(before)).map((ctx) => ({
    event: ctx.event,
    path: ctx.file?.relativePath ?? null,
    removed: ctx.file?.removed.map((line) => `${line.line}:${line.text}`) ?? null,
  }));

describe("Claude Code payloads", () => {
  test("a prompt is a prompt event", () => {
    expect(summary({ hook_event_name: "UserPromptSubmit", prompt: "add a late field" })).toEqual([{ event: "prompt", path: null, text: "add a late field", written: null }]);
  });

  test("a Bash call is a command event before it runs", () => {
    const payload = { tool_name: "Bash", tool_input: { command: "git status" } };
    expect(summary({ hook_event_name: "PreToolUse", ...payload })).toEqual([{ event: "command", path: null, text: "git status", written: null }]);
    expect(summary({ hook_event_name: "PostToolUse", ...payload })).toEqual([]);
  });

  test("what a Bash call printed is an output event after it ran", () => {
    const payload = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "dart analyze" } };
    const ran = eventsOf({ cwd, ...payload, tool_response: { stdout: "Analyzing app...", stderr: "warning - unused_import" } }, disk({}));
    expect(ran.map((ctx) => [ctx.event, ctx.command, ctx.text, ctx.file])).toEqual([["output", "dart analyze", "Analyzing app...\nwarning - unused_import", null]]);
    // A host that answers with plain text.
    expect(summary({ ...payload, tool_response: "No issues found!" })).toEqual([{ event: "output", path: null, text: "No issues found!", written: null }]);
    // A command that printed nothing is nothing to judge.
    expect(summary({ ...payload, tool_response: { stdout: "", stderr: "" } })).toEqual([]);
  });

  test("a Bash call writes the files git saw it change, and then what it printed", () => {
    const payload = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "dart run build_runner build" }, tool_response: { stdout: "done" } };
    const turn = { writes: [{ file: "/repo/lib/a.dart", written: [{ line: 2, text: "int retries = 3;" }], removed: [], isNew: false }], deletes: [], roots: ["/repo"], failures: [] };
    const events = eventsOf({ cwd, ...payload }, disk({ "/repo/lib/a.dart": legacy }), turn);
    expect(events.map((ctx) => [ctx.event, ctx.file?.relativePath ?? null, ctx.file?.written.map((line) => line.line) ?? null])).toEqual([
      ["write", "lib/a.dart", [2]],
      ["output", null, null],
    ]);
  });

  test("a Bash call outside a git repository writes nothing", () => {
    const command = "cat > lib/a.dart <<'EOF'\nint retries = 3;\nEOF";
    expect(summary({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command } }, { "/repo/lib/a.dart": legacy })).toEqual([]);
  });

  test("what the agent hands to a subagent is a prompt event", () => {
    for (const tool_name of ["Task", "Agent"]) {
      const payload = { hook_event_name: "PreToolUse", tool_name, tool_input: { prompt: "Add a late field to Session" } };
      expect(summary(payload)).toEqual([{ event: "prompt", path: null, text: "Add a late field to Session", written: null }]);
    }
    expect(summary({ hook_event_name: "PostToolUse", tool_name: "Task", tool_input: { prompt: "x" } })).toEqual([]);
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

  test("Edit and Write know what they removed from the file Claude Code says they started from", () => {
    const originalFile = "late User user;\nint retries = 1;\nint timeout = 5;\n";
    const edit = { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "lib/a.dart", new_string: "int retries = 3;" }, tool_response: { originalFile } };
    expect(removals(edit, { "/repo/lib/a.dart": legacy })).toEqual([{ event: "write", path: "lib/a.dart", removed: ["2:int retries = 1;", "3:int timeout = 5;"] }]);
    const write = { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "lib/a.dart" }, tool_response: { type: "update", originalFile } };
    expect(removals(write, { "/repo/lib/a.dart": legacy })[0]?.removed).toEqual(["2:int retries = 1;", "3:int timeout = 5;"]);
  });

  test("Edit falls back to the file as the last look at its repository saw it", () => {
    const edit = { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "lib/a.dart", new_string: "" } };
    expect(removals(edit, { "/repo/lib/a.dart": "a\n" }, { "/repo/lib/a.dart": "a\nb\n" })).toEqual([{ event: "write", path: "lib/a.dart", removed: ["2:b"] }]);
    // Not known at all, nothing was removed as far as a detector can tell.
    expect(removals(edit, { "/repo/lib/a.dart": "a\n" })[0]?.removed).toEqual([]);
  });

  test("a new file removed nothing", () => {
    const write = { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "lib/a.dart" }, tool_response: { type: "create", originalFile: null } };
    expect(removals(write, { "/repo/lib/a.dart": legacy }, { "/repo/lib/a.dart": "stale" })[0]?.removed).toEqual([]);
  });

  test("a file a Bash call deleted in a git repository is a delete event with what it held", () => {
    const payload = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "rm test/a_test.dart" }, tool_response: { stdout: "" } };
    const turn = { writes: [], deletes: [{ file: "/repo/test/a_test.dart", content: "test('a');" }], roots: ["/repo"], failures: [] };
    const events = eventsOf({ cwd, ...payload }, disk({}), turn);
    expect(events.map((ctx) => [ctx.event, ctx.file?.relativePath, ctx.text, ctx.file?.removed])).toEqual([["delete", "test/a_test.dart", "test('a');", [{ line: 1, text: "test('a');" }]]]);
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

  test("a patch that only removes lines is no event, unless the file is known from before", () => {
    const body = patch("*** Update File: lib/a.dart\n@@\n-int old = 1;");
    expect(summary(body, { "/repo/lib/a.dart": legacy })).toEqual([]);
    expect(removals(body, { "/repo/lib/a.dart": legacy }, { "/repo/lib/a.dart": `int old = 1;\n${legacy}` })).toEqual([{ event: "write", path: "lib/a.dart", removed: ["1:int old = 1;"] }]);
  });

  test("a deleted file is a delete event when the file is known from before", () => {
    const body = patch("*** Delete File: test/a_test.dart");
    expect(removals(body, {}, { "/repo/test/a_test.dart": "test('a');\n" })).toEqual([{ event: "delete", path: "test/a_test.dart", removed: ["1:test('a');", "2:"] }]);
    expect(removals(body, {})).toEqual([]);
  });

  test("a moved file is compared with the file it was", () => {
    const body = patch("*** Update File: lib/a.dart\n*** Move to: lib/moved.dart\n@@\n-int old = 1;\n+int retries = 3;");
    expect(removals(body, { "/repo/lib/moved.dart": legacy }, { "/repo/lib/a.dart": "late User user;\nint old = 1;\n" })).toEqual([{ event: "write", path: "lib/moved.dart", removed: ["2:int old = 1;"] }]);
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

describe("where an event happened", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-where-")));
  const session = path.join(base, "app-a");
  const other = path.join(base, "app-b");
  for (const repo of [session, other]) {
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "packages/core/lib"), { recursive: true });
  }
  const read = () => "class A {}";
  const write = (file: string, extra: Partial<HookPayload> = {}) =>
    eventsOf({ cwd: session, hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: file }, ...extra }, read)[0];

  test("a file has an absolute path, and its project is the repository it is in", () => {
    const ctx = write("packages/core/lib/a.dart");
    expect(ctx?.file).toMatchObject({ path: `${session}/packages/core/lib/a.dart`, relativePath: "packages/core/lib/a.dart", name: "a.dart" });
    expect(ctx?.project).toBe(session);
  });

  test("a file in another repository belongs to that one, not to where the session started", () => {
    const ctx = write(path.join(other, "packages/core/lib/b.dart"));
    expect(ctx?.file).toMatchObject({ path: `${other}/packages/core/lib/b.dart`, relativePath: "packages/core/lib/b.dart" });
    expect(ctx?.project).toBe(other);
  });

  test("a file in no repository has no project", () => {
    const ctx = write(path.join(base, "notes.dart"));
    expect(ctx?.file).toMatchObject({ path: `${base}/notes.dart`, relativePath: "notes.dart" });
    expect(ctx?.project).toBeNull();
  });

  test("a prompt and a command know the folder the session runs in", () => {
    const below = path.join(session, "packages");
    expect(eventsOf({ cwd: below, hook_event_name: "UserPromptSubmit", prompt: "hi" }, read)[0]?.cwd).toBe(below);
    expect(eventsOf({ cwd: base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }, read)[0]?.cwd).toBe(base);
    expect(write("lib/new.dart")?.cwd).toBeNull();
  });

  test("a prompt and a command happen in the session's repository", () => {
    expect(eventsOf({ cwd: path.join(session, "packages"), hook_event_name: "UserPromptSubmit", prompt: "hi" }, read)[0]?.project).toBe(session);
    expect(eventsOf({ cwd: base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }, read)[0]?.project).toBeNull();
  });

  test("a write that created the file says so", () => {
    expect(write("lib/new.dart", { tool_response: { type: "create" } })?.file?.isNew).toBe(true);
    expect(write("lib/new.dart", { tool_response: { originalFile: null } })?.file?.isNew).toBe(true);
    expect(write("lib/old.dart", { tool_response: { type: "update", originalFile: "x" } })?.file?.isNew).toBe(false);
    expect(write("lib/unknown.dart")?.file?.isNew).toBe(false);
    const patched = eventsOf(
      { cwd: session, hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: { command: "*** Add File: lib/b.dart\n+final b = 1;\n*** Update File: lib/c.dart\n@@\n+class A {}" } },
      read,
    );
    expect(patched.map((ctx) => [ctx.file?.relativePath, ctx.file?.isNew])).toEqual([
      ["lib/b.dart", true],
      ["lib/c.dart", false],
    ]);
  });
});
