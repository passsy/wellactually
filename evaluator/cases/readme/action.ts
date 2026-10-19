/**
 * Advice after a write lands in that write, on a principle the models break.
 *
 * Asked for a README, the models write paragraphs with several sentences on a
 * line. passsy/write-markdown fires on the file, and the prose should end up
 * one sentence per line within the same change.
 */

import type { Axis } from '../../lib/types.ts';
import { buildFixture } from '../../lib/ts-fixture.ts';
import { README_TASK, readmeChecks, readmeFacts, readmeRubric } from '../../lib/readme-task.ts';

export const axis: Axis = 'action';
export const principles = ['passsy/write-markdown'];
export const prompt = README_TASK;
export const timeoutMs = 240_000;

export const build = buildFixture;
export const rubric = readmeRubric('The agent was shown advice on writing markdown, one sentence per line first, after writing.');
export const facts = readmeFacts;
export const checks = readmeChecks;
