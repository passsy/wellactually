/**
 * Codex, driven headlessly.
 *
 * Codex reads hooks from `<project>/.codex/hooks.json` and refuses to run a
 * hook it has not been shown, so every trial passes
 * `--dangerously-bypass-hook-trust`. That is safe here and only here: the hook
 * being trusted is a file this evaluator wrote seconds earlier.
 *
 * `CODEX_HOME` points at a throwaway directory with a copy of the real
 * auth.json. Without it a trial inherits the installed plugin and the user's
 * own config, which is the same contamination the Claude harness disables.
 *
 * Every trial shells out to the `codex` CLI directly. Nothing here goes through
 * an npm script or a plugin command: the evaluator measures the agent, so it
 * has to invoke the agent the way a person would.
 */

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Injection, McpServer, ModelGroup, Outcome, RunRequest } from '../types.ts';

/** Only the parts of `codex exec --json` this harness reads. */
interface CodexEvent {
  type?: string;
  message?: string;
  error?: { message?: string };
  msg?: { type?: string; message?: string };
  item?: {
    type?: string;
    text?: string;
    command?: string;
    exit_code?: number;
    aggregated_output?: string;
    changes?: unknown;
    message?: string;
  };
}

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export const id = 'codex';
/** Slugs come from ~/.codex/models_cache.json; a ChatGPT account rejects some. */
export const defaultModel = 'gpt-5.6-terra';

/**
 * A hook only fires from `$CODEX_HOME/hooks.json`. A repo-local
 * `<project>/.codex/hooks.json` is documented as a discovery location but does
 * not execute, which is openai/codex#17532. Measured here on codex-cli 0.145.0
 * with an isolated home: global fires, repo-local does not.
 *
 * Event names are the same PascalCase as Claude's.
 */
export function prepare(dir: string, injection: Injection, runDir: string): void {
  const home = codexHome(runDir);
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, 'config.toml'),
    `[features]
hooks = true
apps = false
browser_use = false
computer_use = false
goals = false
image_generation = false
in_app_browser = false
memories = false
multi_agent = false
plugin_sharing = false
plugins = false
remote_plugin = false
skill_search = false
workspace_dependencies = false
${injection.mcp ? mcpServer(injection.mcp) : ''}`,
  );

  if (!injection.hooks) {
    return;
  }
  const hooks: Record<string, unknown[]> = {};
  for (const { event, matcher, command } of injection.hooks) {
    (hooks[event] ??= []).push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout: 10 }] });
  }

  writeFileSync(
    join(home, 'hooks.json'),
    `${JSON.stringify(
      {
        description: 'wellactually evaluator arm',
        hooks,
      },
      null,
      2,
    )}\n`,
  );
}

/** The plugin's server, the way the plugin's .codex-plugin/mcp.json starts it. */
function mcpServer(server: McpServer): string {
  const env = Object.entries(server.env)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join('\n');
  // Without it every call fails in exec mode: "requires approval, but approval policy is never".
  return `\n[mcp_servers.wellactually]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\ndefault_tools_approval_mode = "approve"\n\n[mcp_servers.wellactually.env]\n${env}\n`;
}

function codexHome(runDir: string): string {
  return join(runDir, 'codex-home');
}

export function codexArgs(
  dir: string,
  prompt: string,
  model: string,
  effort?: string,
  sandbox: 'workspace-write' | 'danger-full-access' = 'workspace-write',
): string[] {
  return [
    'exec',
    '--json',
    '--model',
    model,
    ...(effort
      ? ['--strict-config', '--config', `model_reasoning_effort="${effort}"`]
      : []),
    '--cd',
    dir,
    '--sandbox',
    sandbox,
    // Trust is recorded against a hash of the hook definition, which cannot be
    // pre-registered non-interactively. Safe here: the hook being trusted is a
    // file this evaluator wrote seconds ago into a throwaway home.
    '--dangerously-bypass-hook-trust',
    '--skip-git-repo-check',
    prompt,
  ];
}

export async function run({
  dir,
  prompt,
  model,
  effort,
  timeoutMs,
  runDir,
  sandbox,
}: RunRequest): Promise<Outcome> {
  const auth = join(homedir(), '.codex', 'auth.json');
  if (!existsSync(auth)) {
    return { ok: false, error: `codex needs ${auth}` };
  }

  const home = codexHome(runDir);
  mkdirSync(home, { recursive: true });
  copyFileSync(auth, join(home, 'auth.json'));
  const models = join(homedir(), '.codex', 'models_cache.json');
  if (existsSync(models)) {
    copyFileSync(models, join(home, 'models_cache.json'));
  }

  const args = codexArgs(dir, prompt, model, effort, sandbox);

  const { code, stdout, stderr, timedOut } = await exec('codex', args, dir, timeoutMs, home);

  if (timedOut) {
    return { ok: false, error: `timed out after ${timeoutMs}ms`, transcript: stdout };
  }
  const reportedError = codexError(stdout);
  if (reportedError) {
    return { ok: false, error: reportedError, transcript: stdout };
  }
  if (code !== 0) {
    const diagnostic = stderr
      .split('\n')
      .filter((line) => line.trim() && line.trim() !== 'Reading additional input from stdin...')
      .join('\n');
    return {
      ok: false,
      error: `exit ${code}: ${(diagnostic || stdout).slice(0, 300)}`,
      transcript: stdout,
    };
  }

  // JSONL events. The last agent message is the answer; anything that looks
  // like an error event fails the trial rather than scoring an empty answer.
  let text = '';
  let turns = 0;
  const events: CodexEvent[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    let event: CodexEvent;
    try {
      event = JSON.parse(line) as CodexEvent;
    } catch {
      continue;
    }
    events.push(event);
    const type = event.type ?? event.msg?.type;
    // A failed turn still exits 0, so the exit code alone cannot be trusted.
    if (type === 'error' || type === 'stream_error' || type === 'turn.failed') {
      return {
        ok: false,
        error: event.message ?? event.error?.message ?? event.msg?.message ?? 'codex error event',
        transcript: stdout,
      };
    }
    if (type === 'agent_message' || type === 'item.completed') {
      // The hook-trust banner arrives as an item of type "error"; it is a
      // warning about the flag this harness passes on purpose, not a failure.
      const item = event.item;
      if (item?.type === 'error') {
        continue;
      }
      const message = event.message ?? event.msg?.message ?? item?.text;
      if (typeof message === 'string' && message.trim()) {
        text = message;
      }
    }
    turns += 1;
  }

  if (!text.trim()) {
    return { ok: false, error: 'codex produced no agent message', transcript: stdout };
  }

  // Codex names no model anywhere in its JSONL — not on `thread.started`, not
  // on `turn.completed`. Measured on codex-cli 0.146.0. The requested slug is
  // therefore the only record, which is tolerable because codex slugs are
  // already versioned (`gpt-5.6-sol`) rather than moving aliases like `sonnet`.
  return { ok: true, text, turns, transcript: stdout, events, agentVersion: version() };
}

/** The CLI emits useful API failures as JSONL even when stderr only has progress. */
export function codexError(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line) as CodexEvent;
      const type = event.type ?? event.msg?.type;
      if (type !== 'error' && type !== 'stream_error' && type !== 'turn.failed') {
        continue;
      }
      const message = event.message ?? event.error?.message ?? event.msg?.message;
      if (!message) {
        return 'codex error event';
      }
      try {
        const nested = JSON.parse(message) as { error?: { message?: string } };
        return nested.error?.message ?? message;
      } catch {
        return message;
      }
    } catch {
      // A non-JSON progress line cannot describe a structured Codex failure.
    }
  }
  return null;
}

/**
 * Codex keeps a real list on disk and refreshes it itself, so `--help` can show
 * what is actually available today rather than whatever was true when this file
 * was written. Entries marked `visibility: hide` are internal — `codex-auto-review`
 * is one — and are not things to point `--model` at.
 */
export function models(): ModelGroup[] {
  const path = join(homedir(), '.codex', 'models_cache.json');
  try {
    const cache = JSON.parse(readFileSync(path, 'utf8')) as {
      fetched_at?: string;
      models?: { slug?: string; visibility?: string }[];
    };
    const ids = (cache.models ?? [])
      .filter((m) => m.visibility === 'list' && m.slug)
      .map((m) => m.slug as string);
    const on = cache.fetched_at?.slice(0, 10);
    return [{ ids, source: `~/.codex/models_cache.json${on ? `, fetched ${on}` : ''}` }];
  } catch {
    // The cache appears once codex has run at least once. Saying so beats
    // printing a hardcoded list that quietly rots.
    return [{ ids: [], source: `no ${path} yet — run codex once` }];
  }
}

let cachedVersion: string | undefined;

/** `codex-cli 0.146.0`. Cached: it cannot change mid-run. */
function version(): string | undefined {
  if (cachedVersion === undefined) {
    const { status, stdout } = spawnSync('codex', ['--version'], { encoding: 'utf8' });
    cachedVersion = status === 0 ? stdout.trim() : '';
  }
  return cachedVersion || undefined;
}

/**
 * Everything useful for diagnosis is copied outside CODEX_HOME before cleanup:
 * transcript, injected context, facts, and verdict. The home itself otherwise
 * accumulates remote catalogs and SQLite state for every trial, wasting tens of
 * megabytes each and retaining a copied live credential.
 */
export function cleanup(runDir: string): void {
  const rollout = findRollout(join(codexHome(runDir), 'sessions'));
  if (rollout) {
    copyFileSync(rollout, join(runDir, 'rollout.jsonl'));
  }
  rmSync(codexHome(runDir), { recursive: true, force: true });
}

/** The JSONL rendered as something a person can read end to end. */
export function render(events: unknown[] | undefined): string {
  if ((events ?? []).some((event) => (event as RolloutLine).type === 'response_item')) {
    return renderRollout(events as RolloutLine[]);
  }
  const out = [];

  for (const event of (events ?? []) as CodexEvent[]) {
    const item = event.item;
    if (event.type !== 'item.completed' || !item) {
      continue;
    }
    if (item.type === 'agent_message') {
      out.push(`### assistant\n\n${item.text ?? ''}`);
    } else if (item.type === 'reasoning') {
      out.push(`### reasoning\n\n${clip(item.text ?? '')}`);
    } else if (item.type === 'command_execution') {
      out.push(
        `### command (exit ${item.exit_code ?? '?'})\n\n\`\`\`\n${item.command ?? ''}\n\`\`\`\n\n\`\`\`\n${clip(item.aggregated_output ?? '')}\n\`\`\``,
      );
    } else if (item.type === 'file_change') {
      out.push(`### file change\n\n\`\`\`\n${clip(JSON.stringify(item.changes ?? item, null, 2))}\n\`\`\``);
    } else if (item.type === 'error') {
      out.push(`### notice\n\n${item.message ?? ''}`);
    }
  }

  return out.join('\n\n');
}

/** Command output runs to tens of thousands of characters; keep the shape. */
function clip(value: string, limit = 4000): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n… [${value.length - limit} more characters]`;
}

function exec(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  codexHome: string,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, CODEX_HOME: codexHome },
      // Codex reads extra instructions from stdin and waits for EOF. An
      // inherited pipe nobody writes to hangs the trial until the timeout,
      // which looks exactly like a slow model.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(error), timedOut });
    });
  });
}

/** The session file Codex kept, the only record of what the model was actually handed. */
function findRollout(dir: string): string | null {
  if (!existsSync(dir)) {
    return null;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findRollout(path);
      if (found) {
        return found;
      }
    } else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      return path;
    }
  }
  return null;
}

/** Only the parts of a Codex rollout line this harness reads. */
interface RolloutLine {
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    name?: string;
    input?: string;
    arguments?: string;
    output?: unknown;
    content?: { type?: string; text?: string }[];
    summary?: { text?: string }[];
  };
}

/**
 * The rollout Codex keeps for a session, rendered in order.
 *
 * Unlike `exec --json`, it holds what the model was actually handed: hook
 * advice arrives as a developer message right after the tool call that fired
 * it, so the page can show where the advice landed and what came next. The
 * instructions Codex sends before the user's prompt are left out.
 */
function renderRollout(lines: RolloutLine[]): string {
  const out: string[] = [];
  let started = false;
  for (const line of lines) {
    const item = line.payload;
    if (line.type !== 'response_item' || !item) {
      continue;
    }
    const text = (item.content ?? []).map((part) => part.text ?? '').join('\n').trim();
    if (item.type === 'message') {
      if (item.role === 'user' && !text.startsWith('<environment')) {
        started = true;
        out.push(`### user\n\n${text}`);
      } else if (item.role === 'developer' && text.includes('<wellactually')) {
        out.push(`### injected advice\n\n${text}`);
      } else if (item.role === 'assistant' && started) {
        out.push(`### assistant\n\n${text}`);
      }
    } else if (!started) {
      continue;
    } else if (item.type === 'custom_tool_call' || item.type === 'function_call') {
      out.push(`### tool: ${item.name ?? 'tool'}\n\n\`\`\`\n${clip(item.input ?? item.arguments ?? '')}\n\`\`\``);
    } else if (item.type === 'custom_tool_call_output' || item.type === 'function_call_output') {
      out.push(`### result\n\n\`\`\`\n${clip(outputText(item.output))}\n\`\`\``);
    } else if (item.type === 'reasoning') {
      const summary = (item.summary ?? []).map((part) => part.text ?? '').join('\n').trim();
      // Codex keeps its reasoning encrypted; only a summary, when it wrote one, is readable.
      out.push(`### reasoning\n\n${summary || '_encrypted, not readable_'}`);
    }
  }
  return out.join('\n\n');
}

function outputText(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  if (Array.isArray(output)) {
    return output.map((part) => (part as { text?: string }).text ?? '').join('\n');
  }
  return JSON.stringify(output ?? '');
}
