/**
 * The verdict, decided by a model.
 *
 * What these cases actually ask is whether an answer reads as an inventory or
 * as an audit, and whether an offer to fix came after the question was answered
 * or instead of it. A regex cannot see that. It can only see whether some
 * string appeared, which is a different question that happens to correlate
 * until it stops: an early version of this file scored "31/48 blocks listed"
 * for an answer that listed all of them in a table, and would have reported a
 * regression that did not exist.
 *
 * The judge is pinned and never varies with the harness under test. Comparing
 * Codex against Claude means nothing if a different model graded each column,
 * so the model that runs the trial and the model that scores it are unrelated
 * on purpose.
 *
 * Pinning the model is not enough on its own. Grading runs through the same CLI
 * a person uses, which brings that person's whole machine with it: their global
 * CLAUDE.md, their skills, their MCP servers, their hooks. Measured on this
 * machine, a judge prompt that mentioned a catch block had the installed
 * plugin fire its UserPromptSubmit hook and inject the rule under test
 * verbatim into the grader. A judge that has read the rule is
 * not grading blind, and the same prompt graded on another machine would be
 * graded against different text.
 *
 * So `--safe-mode`, which turns every customization off: CLAUDE.md, skills,
 * plugins, hooks, MCP servers, commands, agents. The trials themselves already
 * had their own isolation, `--setting-sources project`; the judge had none.
 *
 * The grading instructions are the session's system prompt rather than the
 * first half of the message, which is what a grader wants — nothing about
 * writing code belongs in it — and also what lets the CLI cache a prefix that
 * no longer changes from trial to trial. Measured, a steady state grading call
 * went from $0.083 to $0.008 with no change to the verdicts.
 */

import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Facts, Verdict } from './types.ts';

export interface JudgeRequest {
  rubric: string;
  request: string;
  answer: string;
  facts: Facts;
  ruleInjected: boolean;
  model?: string;
  timeoutMs?: number;
}

type Reply = { ok: true; text: string; costUsd?: number } | { ok: false; error: string };

/**
 * Pinned. Changing either invalidates comparisons against earlier runs, so a
 * bump means re-running any cell whose numbers are still being quoted.
 *
 * Effort is pinned for the same reason the model is: it sets the thinking
 * budget, and leaving it to the CLI default would let a CLI update silently
 * change how hard the grader thinks.
 */
export const JUDGE_MODEL = 'claude-sonnet-5';
export const JUDGE_EFFORT = 'high';

const SYSTEM = `You are grading one response from a coding agent.

You will be given: the request the agent received, the response it produced, and
objective facts an automated harness observed about the run. The facts are
reliable. The response is what you are judging.

Grade only against the rubric. Do not invent additional standards, and do not
reward or punish style, formatting or verbosity unless the rubric says to.

Reply with one JSON object and nothing else, reason before verdict — the
reason is where you decide, and the verdict must state what the reason
concluded:
{"reason": "<one sentence, max 25 words>", "verdict": "pass" | "fail"}`;

export async function judge({
  rubric,
  request,
  answer,
  facts,
  ruleInjected,
  model = JUDGE_MODEL,
  timeoutMs,
}: JudgeRequest): Promise<Verdict> {
  // SYSTEM is sent as the session's system prompt, not as part of the message.
  // `prompt` keeps both together anyway, because it is the record of what the
  // judge was shown and a verdict is only arguable against the whole of it.
  const body = [
    '## Setup',
    ruleInjected
      ? 'The Well Actually plugin was enabled for this run and may have injected expert advice into the agent context.'
      : 'No plugin was enabled. The agent saw only the request. Judge the base task alone.',
    '',
    '## Rubric',
    rubric.trim(),
    '',
    '## The request the agent received',
    request,
    '',
    '## Objective facts observed by the harness',
    '```json',
    JSON.stringify(facts, null, 2),
    '```',
    '',
    '## The response to grade',
    '<response>',
    answer,
    '</response>',
  ].join('\n');
  const prompt = `${SYSTEM}\n\n${body}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const outcome = await ask(body, model, timeoutMs);
    if (!outcome.ok) {
      if (attempt === 2) {
        return { ok: false, error: `judge failed: ${outcome.error}`, prompt };
      }
      continue;
    }

    const parsed = parse(outcome.text);
    if (parsed) {
      // The prompt and the raw reply go back with the verdict. A verdict you
      // disagree with is only worth arguing about once you can see exactly
      // what the judge was shown and exactly what it said.
      return {
        ok: true,
        pass: parsed.verdict === 'pass',
        reason: parsed.reason ?? '',
        prompt,
        raw: outcome.text,
        // Grading is a second paid call per trial. Left unrecorded, a run's
        // reported cost is only what the agent spent and the judge's share
        // silently is not there.
        costUsd: outcome.costUsd,
      };
    }
    if (attempt === 2) {
      return {
        ok: false,
        error: `judge returned no JSON verdict: ${outcome.text.slice(0, 160)}`,
        prompt,
        raw: outcome.text,
      };
    }
  }

  return { ok: false, error: 'judge exhausted retries', prompt };
}

interface Parsed {
  verdict: 'pass' | 'fail';
  reason?: string;
}

function parse(text: string): Parsed | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const braced = /\{[\s\S]*\}/.exec(candidate);
  if (!braced) {
    return null;
  }
  try {
    const value = JSON.parse(braced[0]) as Parsed;
    return value.verdict === 'pass' || value.verdict === 'fail' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Run in an empty directory. The judge has no business reading this repository,
 * and a fixture that is still on disk would let it grade the code instead of
 * the answer.
 */
function ask(message: string, model: string, timeoutMs?: number): Promise<Reply> {
  if (model.startsWith('codex:')) {
    return askCodex(message, model.slice('codex:'.length), timeoutMs);
  }

  const cwd = mkdtempSync(join(tmpdir(), 'wellactually-judge-'));

  return new Promise<Reply>((resolve) => {
    const child = spawn(
      'claude',
      [
        '-p',
        message,
        '--model',
        model,
        '--effort',
        JUDGE_EFFORT,
        '--output-format',
        'json',
        '--allowedTools',
        '',
        // Nothing about the machine this runs on may reach the grader.
        '--safe-mode',
        '--system-prompt',
        SYSTEM,
      ],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs ?? 120_000);

    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', () => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      try {
        const payload = JSON.parse(stdout) as {
          is_error?: boolean;
          result?: string;
          terminal_reason?: string;
          total_cost_usd?: number;
        };
        if (payload.is_error) {
          resolve({
            ok: false,
            error: payload.result ?? payload.terminal_reason ?? 'is_error',
          });
          return;
        }
        resolve({ ok: true, text: payload.result ?? '', costUsd: payload.total_cost_usd });
      } catch {
        resolve({ ok: false, error: (stderr || stdout || 'no output').slice(0, 200) });
      }
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      resolve({ ok: false, error: String(error) });
    });
  });
}

/**
 * Codex judge route for runs where a Claude subscription is unavailable.
 *
 * The explicit `codex:` prefix keeps the existing pinned Claude model and old
 * CLI behaviour unchanged. An isolated CODEX_HOME supplies authentication but
 * no user's config, plugins, hooks, skills or rules.
 */
function askCodex(message: string, model: string, timeoutMs?: number): Promise<Reply> {
  const cwd = mkdtempSync(join(tmpdir(), 'wellactually-codex-judge-'));
  const home = join(cwd, 'codex-home');
  const auth = join(homedir(), '.codex', 'auth.json');
  const reply = join(cwd, 'reply.json');
  const schema = join(cwd, 'verdict.schema.json');

  if (!existsSync(auth)) {
    rmSync(cwd, { recursive: true, force: true });
    return Promise.resolve({ ok: false, error: `codex needs ${auth}` });
  }

  writeFileSync(
    schema,
    `${JSON.stringify(
      {
        type: 'object',
        properties: {
          reason: { type: 'string', maxLength: 240 },
          verdict: { type: 'string', enum: ['pass', 'fail'] },
        },
        required: ['reason', 'verdict'],
        additionalProperties: false,
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.toml'), '');
  copyFileSync(auth, join(home, 'auth.json'));

  return new Promise<Reply>((resolve) => {
    const child = spawn(
      'codex',
      [
        'exec',
        '--model',
        model,
        '--strict-config',
        '--config',
        `model_reasoning_effort="${JUDGE_EFFORT}"`,
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--output-schema',
        schema,
        '--output-last-message',
        reply,
        `${SYSTEM}\n\n${message}`,
      ],
      {
        cwd,
        env: { ...process.env, CODEX_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs ?? 120_000);

    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      let text = '';
      try {
        text = readFileSync(reply, 'utf8');
      } catch {
        // The CLI diagnostic below is more useful than a second filesystem
        // error when no final answer was written.
      }
      rmSync(cwd, { recursive: true, force: true });
      if (code !== 0 || !text.trim()) {
        resolve({
          ok: false,
          error: (stderr || stdout || `codex judge exited ${code}`).slice(0, 300),
        });
        return;
      }
      resolve({ ok: true, text });
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      resolve({ ok: false, error: String(error) });
    });
  });
}
