/**
 * The same change as new-enum, made by a subagent.
 *
 * A subagent has a context of its own, so the advice has to reach it there:
 * its own write fires the hook with its agent id, and its own session memory
 * says it has not seen the advice yet. Claude only, because the case depends
 * on a hookable Task tool.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Axis, Check, Facts, ScoredTrial } from '../../lib/types.ts';
import { buildFixture } from '../../lib/ts-fixture.ts';
import { ORDER_TASK, orderChecks, orderFacts, orderRubric } from '../../lib/order-task.ts';

export const axis: Axis = 'action';
export const harnesses = ['claude'];
export const principles = ['passsy/prefer-union-over-enum'];
export const prompt = `Use a subagent (the Task tool) for this and do not edit any file yourself. ${ORDER_TASK}`;
export const timeoutMs = 300_000;

export const build = buildFixture;
export const rubric = orderRubric('Advice to prefer unions over enums was shown to whichever agent wrote the file.');

/** Whether the transcript shows a subagent being started at all. */
function delegated(runDir: string): boolean {
  try {
    return /"name":"(?:Task|Agent)"/.test(readFileSync(join(runDir, 'transcript.jsonl'), 'utf8'));
  } catch {
    return false;
  }
}

export function facts(trial: ScoredTrial): Facts {
  return { ...orderFacts(trial), aSubagentWasStarted: delegated(trial.runDir) };
}

export function checks(trial: ScoredTrial): Check[] {
  return [{ name: 'a-subagent-was-started', pass: delegated(trial.runDir) }, ...orderChecks(trial)];
}
