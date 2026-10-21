import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, test } from "vitest";
import { writeLockfile } from "../src/board/board.ts";
import { audit, renderAudit } from "../src/audit/audit.ts";
import { countAdvice, readClaudeConversation } from "../src/audit/transcripts.ts";

const NOW = Date.parse("2026-10-21T12:00:00Z");

function advice(...ids: string[]): string {
  const principles = ids.map((id) => `<principle id="${id}" expert="ana" title="T">\nAdvice.\n</principle>`).join("\n\n");
  return `<wellactually>\nwrite lib/a.ts: You just changed this file.\n\n${principles}\n\nUse the MCP tool whose name ends in "rate_principle".\n</wellactually>`;
}

function jsonl(file: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

function hookLog(home: string, entries: Record<string, unknown>[]): void {
  jsonl(
    path.join(home, "logs", "hooks-2026-10-21T11.jsonl"),
    entries.map((entry) => ({ time: "2026-10-21T11:30:00.000Z", events: [], shown: 0, ms: 3, ...entry })),
  );
}

describe("auditing recent sessions", () => {
  let base: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-audit-")));
    env = {
      WELLACTUALLY_HOME: path.join(base, "wa"),
      CLAUDE_CONFIG_DIR: path.join(base, "claude"),
      CODEX_HOME: path.join(base, "codex"),
      XDG_DATA_HOME: path.join(base, "data"),
      XDG_CONFIG_HOME: path.join(base, "config"),
    };
    process.env.WELLACTUALLY_HOME = env.WELLACTUALLY_HOME;
    writeLockfile({ syncedAt: "2026-10-21T08:00:00.000Z", entries: [{ id: "ana/no-enums", version: 4, hash: "a".repeat(64), enabled: true }] });
  });

  test("counts the advice blocks, the principles in them and the blocks an agent cut, but not a description naming the tag", () => {
    const conversation = readClaudeConversation(writeEmpty(base));
    countAdvice(conversation, `${advice("ana/no-enums", "joseph/names")}\n${advice("ana/no-enums").slice(0, 60)}`);
    countAdvice(conversation, "Rate it after it was shown to you in an <wellactually> block.");
    expect(conversation.advice).toBe(2);
    expect(conversation.cut).toBe(1);
    expect(conversation.principles).toEqual({ "ana/no-enums": 1, "joseph/names": 1 });
  });

  test("finds in Codex what reached the agent and what it rated, also in a subagent, under the session the hooks report", async () => {
    fs.mkdirSync(env.CODEX_HOME as string, { recursive: true });
    fs.writeFileSync(path.join(env.CODEX_HOME as string, "config.toml"), codexConfig(["session_start", "user_prompt_submit", "pre_tool_use", "post_tool_use", "post_compact", "session_end"]));
    const day = path.join(env.CODEX_HOME as string, "sessions", "2026", "10", "21");
    const root = "01a15e12-35c9-7212-8320-74516c61e093";
    const child = "01a15e12-deb9-7d70-a533-ce4b61ab2f05";
    jsonl(path.join(day, `rollout-2026-10-21T11-00-00-${root}.jsonl`), [
      { timestamp: "2026-10-21T11:00:00.000Z", type: "session_meta", payload: { id: root, session_id: root, cwd: "/code/app", timestamp: "2026-10-21T11:00:00.000Z" } },
      { timestamp: "2026-10-21T11:00:01.000Z", type: "turn_context", payload: { model: "gpt-6.1-sol", disabled_plugin_ids: [] } },
      { timestamp: "2026-10-21T11:00:01.000Z", type: "world_state", payload: { full: true, state: { host_skills: "### Skill roots\n- `r1` = `/h/.codex/plugins/cache/wellactually/wellactually/0.10.0/skills`" } } },
      { timestamp: "2026-10-21T11:00:02.000Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: advice("ana/no-enums") }] } },
    ]);
    jsonl(path.join(day, `rollout-2026-10-21T11-05-00-${child}.jsonl`), [
      { timestamp: "2026-10-21T11:05:00.000Z", type: "session_meta", payload: { id: child, session_id: root, cwd: "/code/app" } },
      { timestamp: "2026-10-21T11:05:01.000Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: advice("joseph/names") }] } },
      {
        timestamp: "2026-10-21T11:05:02.000Z",
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: { type: "McpToolCall", server: "wellactually", tool: "rate_principle", arguments: { id: "joseph/names", rating: "up" }, result: { content: [{ type: "text", text: "Recorded up for joseph/names@2. Thank you." }] } },
        },
      },
    ]);
    hookLog(env.WELLACTUALLY_HOME as string, [
      { hook: "UserPromptSubmit", session: root, transcript: path.join(day, `rollout-2026-10-21T11-00-00-${root}.jsonl`), shown: 400, events: [{ event: "prompt", detectors: [{ id: "ana/no-enums", version: 4, ms: 2, findings: [{}] }], skipped: [], unmatched: 0 }] },
      { hook: "PostToolUse", session: root, transcript: path.join(day, `rollout-2026-10-21T11-05-00-${child}.jsonl`), shown: 300 },
    ]);

    const report = await audit({ hours: 24, agent: "codex", env, now: NOW, cwd: base });
    expect(report.sessions.map((session) => session.session)).toEqual([root]);
    const [session] = report.sessions;
    expect(session?.conversation?.principles).toEqual({ "ana/no-enums": 1, "joseph/names": 1 });
    expect(session?.findings).toEqual([
      "The hooks ran 2 times: UserPromptSubmit 1, PostToolUse 1.",
      "Detectors fired: ana/no-enums (1).",
      "Advice reached the agent 2 times, from ana/no-enums, joseph/names.",
      "The agent rated once: joseph/names up (recorded).",
      "Not rated: ana/no-enums.",
    ]);
    expect(report.summary).toEqual([{ agent: "codex", sessions: 1, advised: 1, rated: 1, ratings: 1 }]);
  });

  test("says that Codex did not run hooks the user has not trusted", async () => {
    fs.mkdirSync(env.CODEX_HOME as string, { recursive: true });
    fs.writeFileSync(path.join(env.CODEX_HOME as string, "config.toml"), codexConfig(["session_start"]));
    const id = "01a15e14-ca08-7bb0-9388-c1bc21367ba4";
    jsonl(path.join(env.CODEX_HOME as string, "sessions", "2026", "10", "21", `rollout-2026-10-21T11-00-00-${id}.jsonl`), [
      { timestamp: "2026-10-21T11:00:00.000Z", type: "session_meta", payload: { id, session_id: id, cwd: "/code/app", timestamp: "2026-10-21T11:00:00.000Z" } },
    ]);
    hookLog(env.WELLACTUALLY_HOME as string, [{ hook: "SessionStart", session: "other", transcript: "/elsewhere.jsonl", note: "started the background sync" }]);

    const report = await audit({ hours: 24, agent: "codex", env, now: NOW, cwd: base });
    expect(report.setups[0]?.untrusted).toEqual(["user_prompt_submit", "pre_tool_use", "post_tool_use", "post_compact", "session_end"]);
    const session = report.sessions.find((candidate) => candidate.session === id);
    expect(session?.findings[0]).toBe(
      "The hooks did not run in this session. Codex runs a plugin's hooks only once they are trusted in `/hooks`, and user_prompt_submit, pre_tool_use, post_tool_use, post_compact, session_end are not.",
    );
    expect(renderAudit(report)).toContain("hooks trusted: session_start.");
  });

  test("reads a Claude Code session: the hooks it ran, the advice it was shown and a rating the server did not record", async () => {
    const file = path.join(env.CLAUDE_CONFIG_DIR as string, "projects", "-code-app", "4db20a80-8415-4321-acb7-92a42a972fa1.jsonl");
    jsonl(file, [
      { type: "attachment", timestamp: "2026-10-21T11:00:00.000Z", cwd: "/code/app", attachment: { type: "hook_success", hookName: "SessionStart:startup", command: 'node "/p/dist/wellactually.mjs" hook', exitCode: 0 } },
      { type: "attachment", timestamp: "2026-10-21T11:01:00.000Z", attachment: { type: "hook_additional_context", content: [advice("ana/no-enums")] } },
      { type: "assistant", timestamp: "2026-10-21T11:02:00.000Z", message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "mcp__plugin_wellactually_wellactually__rate_principle", input: { id: "ana/no-enums", rating: "down" } }] } },
      { type: "user", timestamp: "2026-10-21T11:02:01.000Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "Reporting is turned off on this machine, so the rating was not sent." }] }] } },
    ]);

    const report = await audit({ hours: 24, agent: "claude-code", env, now: NOW, cwd: base });
    const [session] = report.sessions;
    expect(session?.model).toBe("claude-opus-5-5");
    expect(session?.findings).toEqual([
      "Claude Code ran the plugin's hooks once, but the hook log has no line for this session, so it was likely turned off with WELLACTUALLY_HOOK_LOG=0 where the agent ran.",
      "Advice reached the agent once, from ana/no-enums.",
      "The agent rated once: ana/no-enums down (not recorded).",
      "One rating was not recorded. The server said: Reporting is turned off on this machine, so the rating was not sent.",
    ]);
  });

  test("reads OpenCode 2's database and finds a rating the agent made from a script", async () => {
    const file = path.join(env.XDG_DATA_HOME as string, "opencode", "opencode.db");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE session_v2 (id text, directory text, time_created integer, time_updated integer)");
    db.exec("CREATE TABLE session_message (id text, session_id text, type text, seq integer, time_created integer, data text)");
    db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?)").run("ses_1", "/code/app", NOW - 3600_000, NOW - 600_000);
    const message = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)");
    message.run("m1", "ses_1", "system", 1, NOW - 3500_000, JSON.stringify({ text: "Code Mode: rate it after an <wellactually> block was shown." }));
    message.run("m2", "ses_1", "synthetic", 2, NOW - 3400_000, JSON.stringify({ text: advice("ana/no-enums") }));
    const tool = {
      type: "tool",
      name: "execute",
      state: {
        input: { code: 'await tools.wellactually.rate_principle({ id: "ana/no-enums", rating: "up" })' },
        content: [{ type: "text", text: "Recorded up for ana/no-enums@4. Thank you." }],
        metadata: { toolCalls: [{ tool: "wellactually.rate_principle", input: { id: "ana/no-enums", rating: "up" } }] },
      },
    };
    message.run("m3", "ses_1", "assistant", 3, NOW - 3300_000, JSON.stringify({ model: { id: "minimax-m3" }, content: [tool] }));
    db.close();
    hookLog(env.WELLACTUALLY_HOME as string, [{ hook: "UserPromptSubmit", session: "ses_1", cwd: "/code/app", shown: 500 }]);

    const report = await audit({ hours: 24, agent: "opencode", env, now: NOW, cwd: base });
    const [session] = report.sessions;
    expect(session?.model).toBe("minimax-m3");
    expect(session?.conversation?.advice).toBe(1);
    expect(session?.conversation?.ratings).toEqual([{ id: "ana/no-enums", rating: "up", recorded: true, reply: "Recorded up for ana/no-enums@4. Thank you." }]);
  });
});

function writeEmpty(base: string): string {
  const file = path.join(base, "empty.jsonl");
  fs.writeFileSync(file, "");
  return file;
}

function codexConfig(trusted: string[]): string {
  const hooks = trusted.map((event) => `[hooks.state."wellactually@wellactually:hooks/hooks.json:${event}:0:0"]\ntrusted_hash = "sha256:00"\n`).join("\n");
  return `[plugins."wellactually@wellactually"]\nenabled = true\n\n${hooks}`;
}
