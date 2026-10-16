import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

process.env.WELLACTUALLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rater-test-"));
delete process.env.CLAUDE_CODE_SESSION_ID;

const { modelInTranscript, noteToolUse, raterOf } = await import("../src/rater.ts");

function transcript(lines: unknown[]): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "transcript-")), "session.jsonl");
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
  return file;
}

const call = (id: string, model: string) => ({ type: "assistant", message: { model, content: [{ type: "tool_use", id, name: "rate_principle" }] } });

describe("who rates", () => {
  test("Codex names the model of the turn in the tool call", async () => {
    const meta = { "x-codex-turn-metadata": { model: "gpt-6.1-sol", session_id: "s" } };
    expect(await raterOf("codex-mcp-client", meta)).toEqual({ agent: "codex", model: "gpt-6.1-sol" });
  });

  test("the pi plugin names the model it knows", async () => {
    expect(await raterOf("pi", { "wellactually/model": "qwen3-coder-next" })).toEqual({ agent: "pi", model: "qwen3-coder-next" });
  });

  test("Claude Code's model comes from the transcript the hook noted", async () => {
    const file = transcript([call("toolu_1", "claude-sonnet-5-5"), { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_2" }] } }, call("toolu_2", "claude-opus-5-5")]);
    await noteToolUse("toolu_1", file);
    expect(await raterOf("claude-code", { "claudecode/toolUseId": "toolu_1" })).toEqual({ agent: "claude-code", model: "claude-sonnet-5-5" });
    // The note is used once.
    expect(await raterOf("claude-code", { "claudecode/toolUseId": "toolu_1" })).toEqual({ agent: "claude-code", model: null });
  });

  test("waits for Claude Code to write the tool call", async () => {
    const file = transcript([call("toolu_earlier", "claude-opus-5-5")]);
    setTimeout(() => fs.appendFileSync(file, `\n${JSON.stringify(call("toolu_late", "claude-sonnet-5-5"))}`), 300);
    await noteToolUse("toolu_late", file);
    expect(await raterOf("claude-code", { "claudecode/toolUseId": "toolu_late" })).toEqual({ agent: "claude-code", model: "claude-sonnet-5-5" });
  });

  test("finds a subagent's tool call next to the session's transcript", async () => {
    const file = transcript([call("toolu_main", "claude-opus-5-5")]);
    const subagents = path.join(file.replace(/\.jsonl$/, ""), "subagents");
    fs.mkdirSync(subagents, { recursive: true });
    fs.writeFileSync(path.join(subagents, "agent-1.jsonl"), JSON.stringify(call("toolu_sub", "claude-haiku-5-5")));
    await noteToolUse("toolu_sub", file);
    expect((await raterOf("claude-code", { "claudecode/toolUseId": "toolu_sub" })).model).toBe("claude-haiku-5-5");
  });

  test("leaves out what it cannot tell", async () => {
    expect(await raterOf(undefined, undefined)).toEqual({ agent: null, model: null });
    expect(await raterOf("some client with spaces", { "x-codex-turn-metadata": { model: 7 } })).toEqual({ agent: null, model: null });
    expect(modelInTranscript(transcript([call("toolu_3", "<synthetic>")]), "toolu_3")).toBeNull();
    expect(modelInTranscript("/does/not/exist.jsonl", "toolu_3")).toBeNull();
  });
});
