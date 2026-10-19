/**
 * From a command line to a trial matrix.
 *
 * A run is the cross product agents × cases × arms, with `--n` trials per
 * cell — the epochs of other eval frameworks. The plan is data, so a resumed
 * run can rebuild exactly the queue the interrupted one had and fill in the
 * trials that are missing.
 */

import type { AgentSpec } from './agent-spec.ts';
import { agentKey, parseAgentSpec } from './agent-spec.ts';
import { parseArm } from './arms.ts';
import type { Arm, Case, Harness } from './types.ts';

export interface Options {
  agents: AgentSpec[];
  case: string[];
  arms: Arm[];
  n: number;
  concurrency: number;
  judgeModel: string;
  /** Path of a finished run whose trials should be re-graded, agents untouched. */
  rescore?: string;
  /** Path of an interrupted run whose missing trials should be filled in. */
  resume?: string;
}

export interface Cell {
  harness: Harness;
  model: string;
  effort?: string;
  testCase: Case;
  arm: Arm;
}

export interface Trial extends Cell {
  n: number;
}

export function planCells(
  options: Options,
  harnesses: Record<string, Harness>,
  cases: Record<string, Case>,
  fail: (message: string) => never,
): Cell[] {
  const cells: Cell[] = [];
  for (const agent of options.agents) {
    const harness = harnesses[agent.harness];
    if (!harness) {
      fail(`unknown harness: ${agent.harness}`);
    }
    for (const selector of options.case) {
      const matched = Object.keys(cases).filter(
        (id) => id === selector || id.startsWith(`${selector}/`),
      );
      if (matched.length === 0) {
        fail(`no case matches: ${selector}\nKnown:\n  ${Object.keys(cases).sort().join('\n  ')}`);
      }
      for (const id of matched) {
        const testCase = cases[id] as Case;
        if (testCase.harnesses && !testCase.harnesses.includes(harness.id)) {
          continue;
        }
        for (const arm of options.arms) {
          cells.push({ harness, model: agent.model, effort: agent.effort, testCase, arm });
        }
      }
    }
  }
  return cells;
}

export function planQueue(cells: Cell[], n: number): Trial[] {
  return cells.flatMap((cell) => Array.from({ length: n }, (_, i) => ({ ...cell, n: i + 1 })));
}

/**
 * Case first, so a listing groups every trial of a rule together and the two
 * arms of one cell sort next to each other. Leading with the harness put all
 * 48 directories under `claude-sonnet-` and buried the part being looked for.
 *
 * The model here is the resolved one wherever it is known. `sonnet` is an
 * alias that points somewhere else every few months, so a directory named
 * after it cannot be compared against one from last quarter.
 */
export function trialDirName(
  caseId: string,
  harnessId: string,
  model: string,
  effort: string | undefined,
  armName: string,
  n: number,
): string {
  // `claude` + `claude-sonnet-5` reads as claude-claude-sonnet-5. The model id
  // already names its vendor, so the harness only earns a slot when it adds
  // something.
  const who = model.startsWith(`${harnessId}-`) ? model : `${harnessId}-${model}`;
  return `${caseId}-${who}-effort-${effort ?? 'default'}-${armName}-${n}`.replaceAll(
    /[^\w.-]/g,
    '_',
  );
}

/**
 * The identity of one planned trial, independent of directory naming, so a
 * resume can match stored trials against the plan even after a directory was
 * renamed to the resolved model id.
 */
export function trialKey(trial: {
  harness: string;
  requestedModel: string;
  effort?: string;
  caseId: string;
  arm: string;
  n: number;
}): string {
  return [
    trial.harness,
    trial.requestedModel,
    trial.effort ?? 'default',
    trial.caseId,
    trial.arm,
    trial.n,
  ].join('\u0000');
}

export interface ParseInput {
  argv: string[];
  defaultJudge: string;
  defaultModels: Record<string, string>;
  usage: () => string;
}

/**
 * A declared function rather than a callback parameter, because TypeScript
 * only treats a call as unreachable-after when the callee is a plain
 * declaration with an explicit `never` return.
 */
function abort(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/**
 * One row per flag, so `--help` cannot drift from what is actually parsed:
 * anything documented here is read by `parseOptions`, and anything read there
 * has to be listed here to have a default at all.
 */
export const FLAGS = [
  ['--agent', 'claude + codex defaults', 'repeatable: harness[:model[:effort]]'],
  ['--case', 'all', 'path prefixes: PW-D001, PW-D001/uploader-retry, control'],
  ['--arms', 'baseline,plugin', 'baseline (no injection), plugin (this tree), text:<file> (a rendering)'],
  ['--n', '3', 'trials per cell'],
  ['--concurrency', '6', 'trials in flight'],
  ['--judge-model', '(pinned)', 'override the judge, invalidating comparisons'],
  ['--rescore', '', 're-grade a finished run from its stored trials, no agent runs'],
  ['--resume', '', 'fill in the missing or errored trials of an interrupted run'],
] as const;

export function parseOptions({ argv, defaultJudge, defaultModels, usage }: ParseInput): Options {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  // A misspelled flag would otherwise be ignored in silence, and the run would
  // quietly measure the defaults instead of what was asked for.
  const known = new Set<string>(FLAGS.map(([flag]) => flag));
  const unknown = argv.filter((arg) => arg.startsWith('--') && !known.has(arg));
  if (unknown.length > 0) {
    abort(`unknown option: ${unknown.join(', ')}\n\n${usage()}`);
  }

  const value = (flag: string, fallback: string | null): string | null => {
    const at = argv.indexOf(flag);
    return at === -1 ? fallback : (argv[at + 1] ?? fallback);
  };
  const values = (flag: string): string[] =>
    argv.flatMap((arg, index) => {
      if (arg !== flag) {
        return [];
      }
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) {
        abort(`missing value for ${flag}`);
      }
      return [next];
    });
  const list = (flag: string, fallback: string): string[] =>
    String(value(flag, fallback)).split(',').filter(Boolean);

  // A mistyped arm is a thing the person can fix, so it is worth a sentence
  // rather than a stack trace out of the parser.
  const arms = (specs: string[]): Arm[] => {
    try {
      return specs.map(parseArm);
    } catch (error) {
      abort(error instanceof Error ? error.message : String(error));
    }
  };

  let agents: AgentSpec[];
  try {
    const specs = values('--agent');
    agents = (specs.length > 0 ? specs : ['claude', 'codex']).map((spec) =>
      parseAgentSpec(spec, defaultModels),
    );
  } catch (error) {
    abort(error instanceof Error ? error.message : String(error));
  }
  const duplicate = agents.find(
    (agent, index) =>
      agents.findIndex((candidate) => agentKey(candidate) === agentKey(agent)) !== index,
  );
  if (duplicate) {
    abort(`duplicate --agent: ${agentKey(duplicate)}`);
  }

  const rescore = value('--rescore', null);
  const resume = value('--resume', null);
  if (rescore && resume) {
    abort('--rescore and --resume are different modes; pass one');
  }

  return {
    agents,
    case: list('--case', ''),
    arms: arms(list('--arms', 'baseline,plugin')),
    n: Number(value('--n', '3')),
    concurrency: Number(value('--concurrency', '6')),
    judgeModel: value('--judge-model', defaultJudge) ?? defaultJudge,
    rescore: rescore ?? undefined,
    resume: resume ?? undefined,
  };
}
