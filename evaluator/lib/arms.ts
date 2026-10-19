/**
 * What gets injected into a trial, named for where the framing came from.
 *
 * `plugin` runs the hook from this working tree, so editing the framing in
 * packages/cli/src/board/board.ts moves the numbers on the next run. `baseline`
 * injects nothing and is the floor: without it there is no way to tell advice
 * that changed behaviour from a model that was going to do that anyway.
 *
 * `framing:<file>` runs the same hook with a candidate `frameEvents` from a
 * module, for trying two wordings against each other before either ships.
 * Only the words differ: the detectors, the principles and the session
 * memory are the ones `plugin` uses.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Arm, HookSpec, Injection } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '..', '..');
const HOOK = join(HERE, 'hook.ts');
const MAIN = join(REPO, 'packages', 'cli', 'src', 'main.ts');

export function parseArm(spec: string): Arm {
  if (spec === 'baseline' || spec === 'plugin') {
    return { name: spec, kind: spec };
  }
  if (spec.startsWith('framing:')) {
    const path = resolve(spec.slice('framing:'.length));
    if (!existsSync(path)) {
      throw new Error(`framing arm points at a missing file: ${path}`);
    }
    return { name: `framing(${path.split('/').pop()})`, kind: 'framing', path };
  }
  throw new Error(`unknown arm: ${spec}. Use baseline, plugin, or framing:<file>`);
}

interface InjectionRequest {
  /** The trial's WELLACTUALLY_HOME, holding its advisory board and session memory. */
  home: string;
  /** Touched by every hook call, so a trial can tell "never ran" from "ran and said nothing". */
  marker: string;
  /** Where every hook call's output is appended. */
  log: string;
  /** Hashes every session of the trial starts out having seen in full. */
  seen: string[];
}

interface HooksFile {
  hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
}

/**
 * The hooks an arm installs, or none for the baseline.
 *
 * Every event and matcher comes from hooks/hooks.json, so a trial sees
 * what an installed plugin sees, compaction and session end included. Only the
 * command differs: this tree's hook, its own home, and a tee that records what
 * the agent was handed. Knowing that a principle fired is not the same as
 * knowing what the agent read.
 */
export function injectionFor(arm: Arm, { home, marker, log, seen }: InjectionRequest): Injection {
  if (arm.kind === 'baseline') {
    return { hooks: null, mcp: null, home };
  }
  const env = [
    `WELLACTUALLY_HOME=${quote(home)}`,
    // The worker script sits beside the CLI, not beside this hook.
    'WELLACTUALLY_WORKERS=0',
    ...(arm.kind === 'framing' ? [`WELLACTUALLY_EVAL_FRAMING=${quote(arm.path ?? '')}`] : []),
    ...(seen.length > 0 ? [`WELLACTUALLY_EVAL_SEEN=${seen.join(',')}`] : []),
  ].join(' ');
  // The hook prints one JSON object without a newline, so the log gets its own to keep one call per line.
  const command = `touch ${quote(marker)} && ${env} node ${quote(HOOK)} | tee -a ${quote(log)} && echo >> ${quote(log)}`;

  const file = JSON.parse(readFileSync(join(REPO, 'hooks', 'hooks.json'), 'utf8')) as HooksFile;
  const hooks: HookSpec[] = Object.entries(file.hooks).flatMap(([event, groups]) =>
    groups.map((group) => ({ event, matcher: group.matcher, command })),
  );
  return {
    hooks,
    // The server the plugin starts, so advice that names its tools names tools the agent has.
    mcp: { command: 'node', args: [MAIN, 'mcp'], env: { WELLACTUALLY_HOME: home } },
    home,
  };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
