/**
 * Claude Code, driven headlessly.
 *
 * The installed wellactually plugin is switched off per project, because it
 * fires from the released bundle with the user's own advisory board and would
 * answer alongside whatever arm is under test. That contamination is silent and
 * it invalidates every number, so it is disabled in the fixture rather than
 * trusted to be absent. MCP servers come only from the trial's own file.
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Injection, ModelGroup, Outcome, RunRequest } from '../types.ts';

/** Only the parts of Claude Code's stream-json this harness reads. */
interface AgentEvent {
  type?: string;
  result?: string;
  is_error?: boolean;
  terminal_reason?: string;
  num_turns?: number;
  total_cost_usd?: number;
  /** On the `system` init event: the alias resolved to a concrete model. */
  model?: string;
  session_id?: string;
  /** In Claude Code's own session file: what a hook added to the context, among other things. */
  attachment?: { type?: string; content?: unknown };
  claude_code_version?: string;
  message?: {
    model?: string;
    content?: {
      type?: string;
      text?: string;
      thinking?: string;
      name?: string;
      input?: unknown;
      content?: unknown;
    }[] | string;
  };
}

export const id = 'claude';
export const defaultModel = 'sonnet';

/**
 * Claude Code ships no inventory to read, so this is two imperfect sources
 * stated separately rather than one list pretending to be authoritative.
 *
 * Aliases are stale-proof by design: an alias keeps pointing at the current
 * model, and what it resolved to is recorded on every run.
 *
 * `~/.claude/stats-cache.json` answers a different question — what this machine
 * has *used* — but its `dailyModelTokens` are dated, and a recent window is a
 * good approximation of what the account can reach. It earns its place because
 * the ids are concrete: pinning `claude-opus-4-8` for a comparison is worth
 * more than pinning `opus`, which will mean something else next quarter.
 *
 * It is not the whole answer. A model released today is absent until it is
 * used, the file is empty on a fresh machine, it is recomputed rather than
 * live, and it mixes in whatever non-Anthropic models Claude Code has been
 * pointed at — hence the `claude-` filter.
 *
 * Anthropic's `GET /v1/models` is the real inventory but needs an
 * `ANTHROPIC_API_KEY`, which a subscription login does not have. `--help` would
 * fail for most people and cost a round trip for the rest.
 */
/**
 * Short enough that the window is its own freshness check. A leftover file,
 * recording that broke, or a schema that moved all produce nothing inside it,
 * and the group drops out on its own — no model name to keep up to date.
 */
const RECENT_DAYS = 7;

export function models(): ModelGroup[] {
  const groups: ModelGroup[] = [
    {
      ids: ['sonnet', 'opus', 'haiku', 'fable'],
      source: 'aliases, resolved at run time; any full id works too (`claude --help`)',
    },
  ];

  const seen = recentlyUsed();
  if (seen.length > 0) {
    groups.push({
      ids: seen,
      source: `used here in the last ${RECENT_DAYS} days (~/.claude/stats-cache.json) — concrete ids, better for a run you want to reproduce`,
    });
  }

  return groups;
}

/**
 * Models this machine has run through Claude Code recently. Usage, not
 * availability: something released today is absent until it is used, and the
 * file is empty on a fresh machine. Good enough to offer, not good enough to
 * present as the inventory.
 */
function recentlyUsed(): string[] {
  try {
    const raw = readFileSync(join(homedir(), '.claude', 'stats-cache.json'), 'utf8');
    const cache = JSON.parse(raw) as {
      dailyModelTokens?: Record<string, { date?: string; tokensByModel?: Record<string, number> }>;
    };
    const cutoff = new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);

    const ids = new Set<string>();
    for (const day of Object.values(cache.dailyModelTokens ?? {})) {
      if ((day.date ?? '') < cutoff) {
        continue;
      }
      for (const id of Object.keys(day.tokensByModel ?? {})) {
        // Claude Code can be pointed at other providers, and those ids turn up
        // here too. They are not things this harness can be asked for.
        if (id.startsWith('claude-')) {
          ids.add(id);
        }
      }
    }
    return [...ids].sort();
  } catch {
    return [];
  }
}

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout: number }[];
}

interface Settings {
  enabledPlugins: Record<string, boolean>;
  hooks?: Record<string, HookEntry[]>;
}

export function prepare(dir: string, injection: Injection, runDir: string): void {
  const settings: Settings = {
    enabledPlugins: { 'wellactually@wellactually': false, 'pascal-rules@pascal-rules': false },
  };

  if (injection.hooks) {
    const hooks: Record<string, HookEntry[]> = {};
    for (const { event, matcher, command } of injection.hooks) {
      const entry: HookEntry = { hooks: [{ type: 'command', command, timeout: 10 }] };
      if (matcher) {
        entry.matcher = matcher;
      }
      (hooks[event] ??= []).push(entry);
    }
    settings.hooks = hooks;
  }
  writeFileSync(
    mcpConfig(runDir),
    `${JSON.stringify({ mcpServers: injection.mcp ? { wellactually: { type: 'stdio', ...injection.mcp } } : {} }, null, 2)}\n`,
  );

  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
}

function mcpConfig(runDir: string): string {
  return join(runDir, 'mcp.json');
}

export function claudeArgs(
  prompt: string,
  model: string,
  effort?: string,
  disallowedTools?: string[],
  mcp?: string,
): string[] {
  // stream-json rather than json, because the single result object hides every
  // tool call. When a verdict looks wrong the interesting part is usually what
  // the agent did before it answered, not the answer.
  return [
    '-p',
    prompt,
    // A fixture is a directory that did not exist a second ago, so it is never
    // a trusted workspace, and Claude Code discards permissions.allow from an
    // untrusted project ("Ignoring N permissions.allow entries"). Trusting each
    // one means writing to the user's global ~/.claude.json from concurrent
    // trials. Skipping instead keeps the result independent of whose machine
    // it ran on, which is the whole point, and every trial is confined to a
    // throwaway fixture.
    //
    // It also has to stay this way for the control cases to mean anything: one
    // asks whether the agent commits when nobody asked it to, and that cannot
    // be observed if committing was blocked.
    '--dangerously-skip-permissions',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    model,
    ...(effort ? ['--effort', effort] : []),
    // Only the fixture's own settings. Without this a trial inherits whatever
    // the person running it has configured: a transcript caught a baseline run
    // opening the user's `pascal-prepare-commit` skill instead of committing,
    // which failed the case for a reason that had nothing to do with any rule.
    '--setting-sources',
    'project',
    '--disable-slash-commands',
    // Only the trial's servers: the plugin's for an arm with advice, none for the baseline.
    ...(mcp ? ['--mcp-config', mcp] : []),
    '--strict-mcp-config',
    ...(disallowedTools && disallowedTools.length > 0
      ? ['--disallowedTools', ...disallowedTools]
      : []),
  ];
}

export async function run({
  dir,
  runDir,
  prompt,
  model,
  effort,
  timeoutMs,
  disallowedTools,
}: RunRequest): Promise<Outcome> {
  const args = claudeArgs(prompt, model, effort, disallowedTools, mcpConfig(runDir));

  const { code, stdout, stderr, timedOut } = await exec('claude', args, dir, timeoutMs);

  if (timedOut) {
    return { ok: false, error: `timed out after ${timeoutMs}ms`, transcript: stdout };
  }

  const events: AgentEvent[] = stdout
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line: string): AgentEvent[] => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });

  const result = events.findLast((event) => event.type === 'result');
  if (!result) {
    return {
      ok: false,
      error: `exit ${code}, no result event: ${(stderr || stdout).slice(0, 300)}`,
      transcript: stdout,
    };
  }

  // A rate limit comes back as a well formed envelope with is_error set.
  // Reading result unconditionally turns "the session limit was hit" into "the
  // model answered with nothing", which is the difference between no data and
  // a finding.
  if (result.is_error) {
    return {
      ok: false,
      error: result.result || result.terminal_reason || 'is_error',
      transcript: stdout,
    };
  }

  // What answered, not what was asked for. `--model sonnet` is an alias that
  // moves, and the assistant events name the model that actually replied. The
  // init event is the fallback; a run that produced no assistant turn has
  // nothing better to offer.
  const init = events.find((event) => event.type === 'system');
  keepSession(init?.session_id, runDir);
  const answered = events.find((event) => event.type === 'assistant')?.message?.model;

  return {
    ok: true,
    text: result.result ?? '',
    turns: result.num_turns,
    costUsd: result.total_cost_usd,
    transcript: stdout,
    events,
    model: answered ?? init?.model,
    agentVersion: init?.claude_code_version,
  };
}

/**
 * Claude Code's own record of the trial's session, moved into the trial.
 *
 * Unlike stream-json it holds what the model was handed: hook advice is an
 * attachment right after the tool call that fired it. The record lives under
 * ~/.claude/projects in a folder named after the fixture, which nothing else
 * uses, so it is moved out rather than left to pile up.
 */
function keepSession(sessionId: string | undefined, runDir: string): void {
  if (!sessionId) {
    return;
  }
  const projects = join(homedir(), '.claude', 'projects');
  let folders: string[] = [];
  try {
    folders = readdirSync(projects);
  } catch {
    return;
  }
  for (const folder of folders) {
    const file = join(projects, folder, `${sessionId}.jsonl`);
    if (existsSync(file)) {
      copyFileSync(file, join(runDir, 'session.jsonl'));
      if (folder.includes('evaluator-output')) {
        rmSync(join(projects, folder), { recursive: true, force: true });
      }
      return;
    }
  }
}

/** The JSONL rendered as something a person can read end to end. */
export function render(events: unknown[] | undefined): string {
  const out = [];

  for (const event of (events ?? []) as AgentEvent[]) {
    if (event.type === 'attachment' && event.attachment?.type === 'hook_additional_context') {
      const advice = ([] as unknown[]).concat(event.attachment.content ?? []).map(String).join('\n\n');
      if (advice.includes('<wellactually')) {
        out.push(`### injected advice\n\n${advice}`);
      }
    }
    if (event.type === 'user' && typeof event.message?.content === 'string' && !out.length) {
      out.push(`### user\n\n${event.message.content}`);
    }
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const part of event.message.content) {
        if (part.type === 'thinking' && part.thinking?.trim()) {
          out.push(`### reasoning\n\n${clip(part.thinking.trim())}`);
        }
        if (part.type === 'text' && part.text?.trim()) {
          out.push(`### assistant\n\n${part.text.trim()}`);
        }
        if (part.type === 'tool_use') {
          out.push(`### tool: ${part.name}\n\n\`\`\`json\n${clip(JSON.stringify(part.input, null, 2))}\n\`\`\``);
        }
      }
    }
    if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const part of event.message.content) {
        if (part.type === 'tool_result') {
          out.push(`### result\n\n\`\`\`\n${clip(text(part.content))}\n\`\`\``);
        }
      }
    }
    if (event.type === 'result') {
      out.push(`### final answer\n\n${event.result ?? ''}`);
    }
  }

  return out.join('\n\n');
}

function text(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  return ((content ?? []) as { text?: string }[])
    .map((part) => part.text ?? JSON.stringify(part))
    .join('\n');
}

/** Tool results run to tens of thousands of characters; keep the shape. */
function clip(value: string, limit = 4000): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n… [${value.length - limit} more characters]`;
}

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function exec(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
