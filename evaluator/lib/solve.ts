/**
 * The solver: everything up to and including the agent's run.
 *
 * One trial is one fresh fixture, one arm's injection, one headless agent run.
 * Everything the agent touched stays in the trial directory — the workspace,
 * the pristine copy, the transcript, the final answer, and `truth.json`, which
 * is what the case's `build` learned while writing the fixture. Persisting the
 * truth is what lets scoring run again later without re-running the agent.
 *
 * Scoring is deliberately not in here. The split follows the shape every eval
 * framework converges on — generate first, grade separately — because grading
 * is the half that gets iterated on, and it should be re-runnable against
 * stored trials at the cost of a judge call rather than an agent run.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { REPO, injectionFor } from './arms.ts';
import { registryFor } from './registry-stub.ts';
import type { Arm, Case, Harness, Outcome } from './types.ts';

export interface SolveRequest {
  harness: Harness;
  model: string;
  effort?: string;
  testCase: Case;
  arm: Arm;
  /** The trial directory everything lands in. */
  runDir: string;
}

export type Solved =
  | { ok: false; error: string }
  | {
      ok: true;
      outcome: Extract<Outcome, { ok: true }>;
    };

export async function solve({
  harness,
  model,
  effort,
  testCase,
  arm,
  runDir,
}: SolveRequest): Promise<Solved> {
  // The tree the agent actually works in, kept beside the transcript rather
  // than in a temp directory that is gone by the time anyone reads the
  // verdict. For an `action` case what the agent wrote *is* the result.
  const dir = join(runDir, 'workspace');
  const pristine = join(runDir, 'pristine');
  mkdirSync(dir, { recursive: true });

  const truth = testCase.build(dir);
  isolateFixtureRepository(dir);
  cpSync(dir, pristine, { recursive: true });
  // The ground truth `build` returned, stored so scoring — now or months from
  // now — grades against what the fixture actually contained.
  writeFileSync(join(runDir, 'truth.json'), `${JSON.stringify(truth, null, 2)}\n`);

  const marker = join(runDir, 'hook-ran');
  const log = join(runDir, 'injected.log');
  const home = join(runDir, 'home');
  // The baseline gets a board too, unused, so the two arms differ only in the hooks.
  const hashes = seedBoard(home, testCase.principles, await registryFor(runDir));
  const seen = (testCase.seen ?? []).map((id) => hashes[id] ?? '');
  harness.prepare(dir, injectionFor(arm, { home, marker, log, seen }), runDir);

  const outcome = await harness.run({
    dir,
    runDir,
    prompt: testCase.prompt,
    model,
    effort,
    timeoutMs: testCase.timeoutMs,
    sandbox: testCase.sandbox,
    disallowedTools: testCase.disallowedTools,
  });

  // Before any early return: the trial directory is kept now, so whatever the
  // harness needed only while the agent was running must not be left in it.
  harness.cleanup?.(runDir);

  if (outcome.transcript) {
    writeFileSync(join(runDir, 'transcript.jsonl'), outcome.transcript);
  }

  if (!outcome.ok) {
    return { ok: false, error: outcome.error };
  }

  // An arm that meant to inject something and did not is not a measurement of
  // that arm. Scoring it would report "the framing had no effect" for what is
  // really "the framing never arrived".
  if (arm.kind !== 'baseline' && !existsSync(marker)) {
    return { ok: false, error: `injection never ran: ${harness.id} did not execute any hook` };
  }

  // A hook that ran and handed over nothing is the same non-measurement: both
  // arms saw the same nothing, and the cell would read as "the framing had no effect".
  if (arm.kind !== 'baseline') {
    const injected = existsSync(log) ? readFileSync(log, 'utf8') : '';
    const missing = (testCase.expectInjected ?? testCase.principles.slice(0, 1)).filter((text) => !injected.includes(text));
    if (missing.length > 0) {
      return { ok: false, error: `arm injected nothing expected: ${missing.join(', ')} never reached the agent` };
    }
    const reason = testCase.unmeasured?.(runDir);
    if (reason) {
      return { ok: false, error: `measured nothing: ${reason}` };
    }
  }

  writeFileSync(join(runDir, 'answer.md'), outcome.text);

  return { ok: true, outcome };
}

/**
 * A fixture under evaluator/output is still physically inside this repository.
 * Without its own Git boundary, `git status` and `git rev-parse` escape into
 * the evaluator source and let the agent inspect cases, rubrics, and unrelated
 * working-tree changes. Cases that intentionally build history already have a
 * repository and are left untouched.
 */
function isolateFixtureRepository(dir: string): void {
  if (existsSync(join(dir, '.git'))) {
    return;
  }

  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'evaluator@example.com');
  git('config', 'user.name', 'Evaluator');
  git('add', '-A');
  git('commit', '-qm', 'Seed evaluator fixture');
}

const PRINCIPLES = join(REPO, 'evaluator', 'principles');
const MAIN = join(REPO, 'packages', 'cli', 'src', 'main.ts');

/**
 * Puts the case's principles on a fresh advisory board in `home`.
 *
 * Each is added the way `wellactually add` adds a local one, built and tested,
 * then given its expert's id: advice from `local/...` is framed without the
 * rating line, so a board of local principles would not measure what users see.
 * The registry is this run's stub, so a rating the agent sends is accepted the
 * way the real one would accept it, and never leaves the machine.
 */
function seedBoard(home: string, principles: string[], registry: { url: string; token: string }): Record<string, string> {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), `${JSON.stringify({ registry: registry.url, token: registry.token, stats: true })}\n`);
  for (const id of principles) {
    execFileSync(process.execPath, [MAIN, 'add', join(PRINCIPLES, id)], {
      env: { ...process.env, WELLACTUALLY_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  if (principles.length === 0) {
    return {};
  }
  const board = join(home, 'board.json');
  const lockfile = JSON.parse(readFileSync(board, 'utf8')) as { entries: { id: string; hash: string }[] };
  for (const entry of lockfile.entries) {
    const slug = entry.id.replace(/^local\//, '');
    entry.id = principles.find((id) => id.endsWith(`/${slug}`)) ?? entry.id;
  }
  writeFileSync(board, `${JSON.stringify(lockfile, null, 2)}\n`);
  return Object.fromEntries(lockfile.entries.map((entry) => [entry.id, entry.hash]));
}
