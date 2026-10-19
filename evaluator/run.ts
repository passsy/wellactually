#!/usr/bin/env node
/**
 * Measures what a framing change does to an agent.
 *
 * The pipeline is the classic eval shape — a dataset of cases, a solver that
 * runs the agent, a scorer that grades what it left behind — with each stage
 * in its own module and this file only wiring them together:
 *
 *   plan.ts     the trial matrix: agents × cases × arms × n
 *   solve.ts    fixture, injection, one headless agent run
 *   score.ts    facts, deterministic checks, the judge
 *   metrics.ts  cells, and the gates that decide whether the table is readable
 *
 * Because solving and scoring are separate and every trial persists its
 * inputs, two more modes fall out:
 *
 *   --resume <run>   fill in the trials an interrupted run never finished
 *   --rescore <run>  re-grade a finished run's stored trials without paying
 *                    for a single agent run
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentKey } from './lib/agent-spec.ts';
import { loadCases } from './lib/cases.ts';
import { JUDGE_MODEL } from './lib/judge.ts';
import { gates, rowsFor, type CellKey, type TrialResult } from './lib/metrics.ts';
import { openReport } from './lib/open-report.ts';
import {
  FLAGS,
  parseOptions,
  planCells,
  planQueue,
  trialDirName,
  trialKey,
  type Cell,
  type Options,
  type Trial,
} from './lib/plan.ts';
import { table } from './lib/report.ts';
import { score, writeTrialReport } from './lib/score.ts';
import { solve } from './lib/solve.ts';
import { writePage } from './lib/page.ts';
import type { Arm, Axis, Case, Harness } from './lib/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

const HARNESSES: Record<string, Harness> = Object.fromEntries(
  await Promise.all(
    ['claude', 'codex'].map(async (name) => [name, (await import(`./lib/harness/${name}.ts`)) as Harness]),
  ),
);

const CASES = await loadCases(join(HERE, 'cases'));

const options = parseOptions({
  argv: process.argv.slice(2),
  defaultJudge: JUDGE_MODEL,
  defaultModels: Object.fromEntries(
    Object.values(HARNESSES).map((harness) => [harness.id, harness.defaultModel]),
  ),
  usage,
});
if (options.case.length === 0) {
  options.case = Object.keys(CASES);
}

interface Environment {
  harness: string;
  requested: string;
  effort?: string;
  resolved?: string;
  cli?: string;
}

if (options.rescore) {
  await rescoreRun(options.rescore);
} else {
  await executeRun();
}

/**
 * A fresh run, or — with --resume — the remainder of an interrupted one. The
 * two share everything: a resume simply starts from a queue where some trials
 * already have a stored result.
 */
async function executeRun(): Promise<void> {
  let outDir: string;
  let effective: Options = options;
  const reused = new Map<string, TrialResult>();

  if (options.resume) {
    outDir = resolveRunDir(options.resume);
    const stored = JSON.parse(readFileSync(join(outDir, 'results.json'), 'utf8')) as {
      options?: Options & { arms: Arm[] };
    };
    if (!stored.options) {
      fail(`${outDir}/results.json holds no options to resume from`);
    }
    // The interrupted run's plan, not today's flags: a resume that silently
    // reinterpreted the matrix would fill the gaps of a different run.
    effective = { ...stored.options, resume: options.resume, judgeModel: stored.options.judgeModel };
    for (const record of storedTrials(outDir)) {
      if (record.ok) {
        reused.set(
          trialKey({
            harness: record.harness,
            requestedModel: record.requestedModel,
            effort: record.effort,
            caseId: record.case,
            arm: record.arm,
            n: record.n,
          }),
          record,
        );
      }
    }
  } else {
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
    outDir = join(HERE, 'output', stamp);
    mkdirSync(outDir, { recursive: true });

    // A stable path to the newest run, so reading the output does not mean
    // finding the right timestamp first.
    try {
      const link = join(HERE, 'output', 'latest');
      rmSync(link, { force: true });
      symlinkSync(stamp, link, 'dir');
    } catch {
      // A symlink is a convenience. Losing it must not lose the run.
    }
  }

  const cells = planCells(effective, HARNESSES, CASES, fail);
  const queue = planQueue(cells, effective.n);
  const pending = queue.filter((trial) => !reused.has(keyOf(trial)));

  process.stdout.write(
    `${queue.length} trials: ${cells.length} cells x ${effective.n}, ${effective.concurrency} at a time` +
      (reused.size > 0 ? `, ${reused.size} reused from the interrupted run` : '') +
      '\n' +
      `models under evaluation:\n${plannedEnvironment(cells)
        .map((model) => `  ${model.harness} · ${model.requested} · effort ${model.effort ?? 'CLI default'}`)
        .join('\n')}\n` +
      `judge model:\n  ${effective.judgeModel}\n\n`,
  );

  const publish = publisher(outDir, effective, cells, queue.length);
  let pagePath = publish([...reused.values()], true, []);
  if (pagePath) {
    openReport(pagePath);
  }

  const fresh = await pool(pending, effective.concurrency, (trial) => runTrial(trial, outDir, effective), (completed, active) => {
    pagePath = publish([...reused.values(), ...completed], true, active) ?? pagePath;
  });

  const results = [...reused.values(), ...fresh];
  pagePath = publish(results, false, []) ?? pagePath;

  report(cellKeys(cells), results, effective, outDir, pagePath);
}

/**
 * Re-grade a finished run. The agents never run; the stored workspace, answer
 * and truth are the whole input, so this is how a rubric edit, a new check, or
 * a judge change gets re-applied for the price of judging alone.
 */
async function rescoreRun(path: string): Promise<void> {
  const outDir = resolveRunDir(path);
  const stored = JSON.parse(readFileSync(join(outDir, 'results.json'), 'utf8')) as {
    options?: Options;
  };
  const effective: Options = stored.options
    ? { ...stored.options, judgeModel: options.judgeModel }
    : options;

  const records = storedTrials(outDir).filter(
    (record) =>
      options.case.length === 0 ||
      options.case.some((selector) => record.case === selector || record.case.startsWith(`${selector}/`)),
  );
  if (records.length === 0) {
    fail(`no stored trials under ${outDir}`);
  }

  process.stdout.write(
    `re-scoring ${records.length} stored trial(s) in ${outDir}\njudge model:\n  ${options.judgeModel}\n\n`,
  );

  const results = await pool(records, effective.concurrency, async (record): Promise<TrialResult> => {
    if (!record.ok) {
      // An errored trial has no answer to grade; it stays what it was.
      return record;
    }
    const testCase = CASES[record.case];
    const harness = HARNESSES[record.harness];
    if (!testCase || !harness) {
      return { ...record, ok: false, error: `case or harness no longer exists: ${record.case}` };
    }
    const arm = record.armSpec ?? { name: record.arm, kind: record.arm === 'baseline' ? 'baseline' : 'plugin' };
    const scored = await score({
      testCase,
      arm: arm as Arm,
      runDir: record.dir,
      judgeModel: options.judgeModel,
    });
    if (!scored.ok) {
      process.stdout.write(`  ERROR ${record.case}/${record.arm}#${record.n}: ${scored.error}\n`);
      return { ...record, ok: false, error: scored.error };
    }
    const updated: TrialResult = {
      ...record,
      ok: true,
      pass: scored.pass,
      reason: scored.reason,
      facts: scored.facts,
      judgeCostUsd: scored.judgeCostUsd,
    };
    writeTrialReport({
      harness,
      model: record.requestedModel,
      effort: record.effort,
      testCase,
      arm: arm as Arm,
      n: record.n,
      judgeModel: options.judgeModel,
      scored,
      runDir: record.dir,
      answeredBy: record.model,
      agentVersion: record.agentVersion,
    });
    writeFileSync(join(record.dir, 'trial.json'), `${JSON.stringify(updated, null, 2)}\n`);
    process.stdout.write(
      `  ${scored.pass ? 'pass ' : 'FAIL '} ${record.case}/${record.arm}#${record.n}  ${scored.reason}\n`,
    );
    return updated;
  });

  const publish = publisher(outDir, effective, [], results.length);
  const pagePath = publish(results, false, []);
  report(cellsOf(results), results, effective, outDir, pagePath);
}

function keyOf(trial: Trial): string {
  return trialKey({
    harness: trial.harness.id,
    requestedModel: trial.model,
    effort: trial.effort,
    caseId: trial.testCase.id,
    arm: trial.arm.name,
    n: trial.n,
  });
}

/** trial.json, from every subdirectory that has one. */
function storedTrials(outDir: string): (TrialResult & { armSpec?: Arm })[] {
  return readdirSync(outDir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) {
      return [];
    }
    const path = join(outDir, entry.name, 'trial.json');
    if (!existsSync(path)) {
      return [];
    }
    try {
      const record = JSON.parse(readFileSync(path, 'utf8')) as TrialResult & { armSpec?: Arm };
      // The directory may have been renamed or copied; what is on disk wins.
      return [{ ...record, dir: join(outDir, entry.name) }];
    } catch {
      return [];
    }
  });
}

function resolveRunDir(path: string): string {
  const absolute = path.startsWith('/') ? path : join(process.cwd(), path);
  const candidate = existsSync(absolute) ? absolute : join(HERE, path);
  if (!existsSync(join(candidate, 'results.json'))) {
    fail(`not a run directory (no results.json): ${candidate}`);
  }
  return realpathSync(candidate);
}

/**
 * Everything downstream of `solve` reports errors as a result, but a build or
 * copy that throws would reject the pool's Promise.all and take every
 * completed trial down with it. One trial's broken fixture costs one cell,
 * not the run.
 */
async function runTrial(trial: Trial, outDir: string, effective: Options): Promise<TrialResult> {
  const { harness, model, effort, testCase, arm, n } = trial;
  const runDir = join(outDir, trialDirName(testCase.id, harness.id, model, effort, arm.name, n));

  const base: TrialResult & { armSpec: Arm } = {
    harness: harness.id,
    requestedModel: model,
    effort,
    case: testCase.id,
    axis: testCase.axis,
    arm: arm.name,
    armSpec: arm,
    n,
    ok: false,
    dir: runDir,
  };

  try {
    // A resume may find the broken remains of the trial it is redoing.
    rmSync(runDir, { recursive: true, force: true });

    const solved = await solve({ harness, model, effort, testCase, arm, runDir });
    if (!solved.ok) {
      return persistError({ ...base, error: solved.error });
    }
    const { outcome } = solved;

    const scored = await score({
      testCase,
      arm,
      runDir,
      judgeModel: effective.judgeModel,
      outcome,
    });
    if (!scored.ok) {
      return persistError({ ...base, model: outcome.model, agentVersion: outcome.agentVersion, error: scored.error });
    }

    const answered = outcome.model ?? model;
    writeTrialReport({
      harness,
      model,
      effort,
      testCase,
      arm,
      n,
      judgeModel: effective.judgeModel,
      scored,
      runDir,
      answeredBy: answered,
      agentVersion: outcome.agentVersion,
      events: outcome.events,
    });

    // Only now is the model that answered known, so the directory gets its
    // real name at the end rather than being called after the alias that was
    // asked for. A trial that errored keeps the alias, which is the honest
    // label: what ran was never established.
    let finalDir = runDir;
    const dirName = trialDirName(testCase.id, harness.id, answered, effort, arm.name, n);
    if (dirName !== relative(outDir, runDir)) {
      const target = join(outDir, dirName);
      try {
        renameSync(runDir, target);
        finalDir = target;
      } catch {
        // A name is a convenience. Losing it must not lose the trial.
      }
    }

    const result: TrialResult & { armSpec: Arm } = {
      ...base,
      dir: finalDir,
      ok: true,
      model: answered,
      agentVersion: outcome.agentVersion,
      pass: scored.pass,
      reason: scored.reason,
      facts: scored.facts,
      judgeCostUsd: scored.judgeCostUsd,
    };
    writeFileSync(join(finalDir, 'trial.json'), `${JSON.stringify(result, null, 2)}\n`);

    process.stdout.write(
      `  ${scored.pass ? 'pass ' : 'FAIL '} ${harness.id}/${answered}@${effort ?? 'default'}/${testCase.id}/${arm.name}#${n}  ${scored.reason}\n`,
    );
    return result;
  } catch (error) {
    const described = error instanceof Error ? (error.stack ?? error.message) : String(error);
    return persistError({ ...base, error: described });
  }
}

function persistError(result: TrialResult & { armSpec: Arm }): TrialResult {
  process.stdout.write(
    `  ERROR ${result.harness}/${result.requestedModel}@${result.effort ?? 'default'}/${result.case}/${result.arm}#${result.n}: ${result.error}\n`,
  );
  try {
    mkdirSync(result.dir, { recursive: true });
    writeFileSync(join(result.dir, 'trial.json'), `${JSON.stringify(result, null, 2)}\n`);
  } catch {
    // The error is already in the run's results; a missing trial.json only
    // costs the resume the chance to skip this directory.
  }
  return result;
}

/**
 * Persist one coherent snapshot and regenerate its self-contained page.
 * Atomic replacement matters because the browser reads this while trials
 * finish.
 */
function publisher(outDir: string, effective: Options, cells: Cell[], total: number) {
  return (results: TrialResult[], running: boolean, active: Trial[]): string | null => {
    const target = join(outDir, 'results.json');
    const temporary = `${target}.next`;
    const keys = cells.length > 0 ? cellKeys(cells) : cellsOf(results);
    const stored = {
      options: effective,
      environment: environmentFor(cells, results),
      judge: effective.judgeModel,
      progress: {
        completed: results.length,
        total,
        running,
        active: active.map((trial) => ({
          harness: trial.harness.id,
          requestedModel: trial.model,
          effort: trial.effort,
          arm: trial.arm.name,
          case: trial.testCase.id,
          n: trial.n,
        })),
      },
      rows: rowsFor(keys, results),
      results,
    };

    try {
      writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`);
      renameSync(temporary, target);
      return writePage(outDir);
    } catch (error) {
      process.stdout.write(`\ncould not update report.html: ${String(error)}\n`);
      return null;
    }
  };
}

function cellKeys(cells: Cell[]): CellKey[] {
  return cells.map((cell) => ({
    harness: cell.harness.id,
    model: cell.model,
    effort: cell.effort,
    caseId: cell.testCase.id,
    axis: cell.testCase.axis,
    arm: cell.arm.name,
  }));
}

/** The distinct cells present in a set of results, for runs read from disk. */
function cellsOf(results: TrialResult[]): CellKey[] {
  const seen = new Map<string, CellKey>();
  for (const result of results) {
    const key = [result.harness, result.requestedModel, result.effort, result.case, result.arm].join(' ');
    if (!seen.has(key)) {
      seen.set(key, {
        harness: result.harness,
        model: result.requestedModel,
        effort: result.effort,
        caseId: result.case,
        axis: result.axis,
        arm: result.arm,
      });
    }
  }
  return [...seen.values()];
}

/**
 * What the numbers were produced by. Without this a results.json says `sonnet`
 * and is uncomparable against one written six months later, when the alias
 * points at a different model.
 */
function environmentFor(cells: Cell[], results: TrialResult[]): Environment[] {
  const environment = new Map<string, Environment>();

  for (const cell of cells) {
    const key = agentKey({ harness: cell.harness.id, model: cell.model, effort: cell.effort });
    environment.set(key, { harness: cell.harness.id, requested: cell.model, effort: cell.effort });
  }
  for (const result of results) {
    if (!result.ok) {
      continue;
    }
    const key = agentKey({ harness: result.harness, model: result.requestedModel, effort: result.effort });
    environment.set(key, {
      harness: result.harness,
      requested: result.requestedModel,
      effort: result.effort,
      resolved: result.model,
      cli: result.agentVersion,
    });
  }

  return [...environment.values()];
}

function plannedEnvironment(cells: Cell[]): Environment[] {
  return environmentFor(cells, []);
}

function report(
  keys: CellKey[],
  results: TrialResult[],
  effective: Options,
  outDir: string,
  pagePath: string | null,
): void {
  const rows = rowsFor(keys.length > 0 ? keys : cellsOf(results), results);

  const environment = environmentFor([], results)
    .map(
      (e) =>
        `  ${e.harness} ${e.cli ?? 'version unknown'} · ` +
        (e.resolved && e.resolved !== e.requested ? `${e.requested} → ${e.resolved}` : e.requested) +
        ` · effort ${e.effort ?? 'CLI default'}`,
    )
    .join('\n');

  process.stdout.write(
    `\n${table(rows)}\n\n${environment}\n  judged by ${effective.judgeModel}\n\n${outDir}\n` +
      (pagePath ? `${pagePath}\n` : ''),
  );

  // Failures are the reason the transcripts exist, so name the files rather
  // than leaving them to be hunted for under a timestamp.
  const failed = results.filter((r) => r.ok && !r.pass);
  if (failed.length > 0) {
    process.stdout.write(
      `\n${failed.length} failing trial(s), each explained in full:\n` +
        failed.map((r) => `  ${join(r.dir, 'trial.md')}\n`).join(''),
    );
  }

  for (const gate of gates(rows)) {
    process.stdout.write(`\n${gate.message}\n`);
    if (gate.failed) {
      process.exitCode = 1;
    }
  }
}

async function pool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  onProgress?: (completed: R[], active: T[]) => void,
): Promise<R[]> {
  const out: R[] = [];
  const completed: R[] = [];
  const active = new Map<number, T>();
  let next = 0;

  const take = (): { index: number; item: T } | null => {
    if (next >= items.length) {
      return null;
    }
    const index = next++;
    return { index, item: items[index] as T };
  };

  const assignments = Array.from({ length: Math.min(limit, items.length) }, () => take());
  for (const assignment of assignments) {
    if (assignment) {
      active.set(assignment.index, assignment.item);
    }
  }
  onProgress?.([...completed], [...active.values()]);

  await Promise.all(
    assignments.map(async (initial) => {
      let assignment = initial;
      while (assignment) {
        const result = await worker(assignment.item);
        out[assignment.index] = result;
        completed.push(result);
        active.delete(assignment.index);
        assignment = take();
        if (assignment) {
          active.set(assignment.index, assignment.item);
        }
        onProgress?.([...completed], [...active.values()]);
      }
    }),
  );
  return out;
}

function usage(): string {
  const width = Math.max(...FLAGS.map(([flag]) => flag.length));
  const defaults = Math.max(...FLAGS.map(([, value]) => value.length));

  return [
    'Measures what the framing of injected advice does to an agent.',
    '',
    'Usage: node run.ts [options]',
    '',
    'Options:',
    ...FLAGS.map(
      ([flag, value, help]) =>
        `  ${flag.padEnd(width)}  ${`[${value}]`.padEnd(defaults + 2)}  ${help}`,
    ),
    `  ${'-h, --help'.padEnd(width)}  ${''.padEnd(defaults + 2)}  this`,
    '',
    'Agent specification:',
    '  --agent harness[:model[:effort]] may be repeated.',
    '  Omit model or effort to use that CLI default; use claude::high to',
    '  combine a default model with an explicit effort.',
    '  Claude: low, medium, high, xhigh, max.',
    '  Codex: model-specific; low, medium, high, xhigh, max, ultra.',
    '',
    'Models:',
    ...Object.values(HARNESSES).flatMap((harness: Harness) => [
      `  ${harness.id}  (default ${harness.defaultModel})`,
      ...(harness.models?.() ?? []).flatMap((group) => [
        ...wrap(group.ids.join(', '), 68).map((line) => `    ${line}`),
        ...wrap(group.source, 68).map((line) => `      ${line}`),
      ]),
    ]),
    '',
    'Cases:',
    ...(() => {
      const ids = Object.keys(CASES).sort();
      const pad = Math.max(...ids.map((id) => id.length));
      return ids.map((id) => `  ${id.padEnd(pad)}  ${(CASES[id] as Case).axis satisfies Axis}`);
    })(),
    '',
    'Results land in evaluator/output/<timestamp>/, with output/latest pointing',
    'at the most recent run. Start with any trial.md.',
    '',
    'Examples:',
    '  node run.ts --case control,new-enum --n 5',
    '  node run.ts --agent codex:gpt-5.6-terra:xhigh --case new-enum/action',
    '  node run.ts --agent claude:opus:high --agent codex:gpt-5.6-terra:medium',
    '  node run.ts --agent claude::high --arms baseline,plugin,framing:./quieter.ts',
    '  node run.ts --rescore output/latest --judge-model claude-sonnet-5',
    '  node run.ts --resume output/2026-08-11T02-15-00-000Z',
  ].join('\n');
}

/** Greedy wrap, so a long model list does not run off the terminal. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const word of text.split(' ')) {
    const last = lines.at(-1);
    if (last !== undefined && `${last} ${word}`.length <= width) {
      lines[lines.length - 1] = `${last} ${word}`;
    } else {
      lines.push(word);
    }
  }
  return lines.length > 0 ? lines : [''];
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
