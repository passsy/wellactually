/**
 * The same change as readme, made by a subagent.
 *
 * The advice has to reach the subagent's own context, through its own write
 * and its own session memory. Claude only, because the case depends on a
 * hookable Task tool.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Axis, Check, Facts, ScoredTrial } from '../../lib/types.ts';
import { buildFixture } from '../../lib/ts-fixture.ts';
import { README_TASK, readmeChecks, readmeFacts, readmeRubric } from '../../lib/readme-task.ts';

export const axis: Axis = 'action';
export const harnesses = ['claude'];
export const principles = ['passsy/write-markdown'];
export const prompt = `Use a subagent (the Task tool) for this and do not edit any file yourself. ${README_TASK}`;
export const timeoutMs = 300_000;

export const build = buildFixture;
export const rubric = readmeRubric('Advice on writing markdown was shown to whichever agent wrote the file.');

function delegated(runDir: string): boolean {
  try {
    return /"name":"(?:Task|Agent)"/.test(readFileSync(join(runDir, 'transcript.jsonl'), 'utf8'));
  } catch {
    return false;
  }
}

export function facts(trial: ScoredTrial): Facts {
  return { ...readmeFacts(trial), aSubagentWasStarted: delegated(trial.runDir) };
}

export function checks(trial: ScoredTrial): Check[] {
  return [{ name: 'a-subagent-was-started', pass: delegated(trial.runDir) }, ...readmeChecks(trial)];
}
