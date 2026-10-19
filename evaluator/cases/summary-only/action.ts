/**
 * The summary alone is enough to change the code.
 *
 * After its first time in a session a principle shows only its one-sentence
 * summary. That cannot be set up by letting the agent see the full advice
 * first: having read it, the agent never writes the enum again, so the
 * principle never fires a second time. So the session starts as if the full
 * advice had been shown long ago, and the first firing is the summary.
 *
 * Same task and discriminator as new-enum.
 */

import type { Axis } from '../../lib/types.ts';
import { injections } from '../../lib/evidence.ts';
import { buildFixture } from '../../lib/ts-fixture.ts';
import { ORDER_TASK, orderChecks, orderFacts, orderRubric } from '../../lib/order-task.ts';

export const axis: Axis = 'action';
export const principles = ['passsy/prefer-union-over-enum'];
export const seen = ['passsy/prefer-union-over-enum'];
export const prompt = ORDER_TASK;
export const timeoutMs = 180_000;

export const build = buildFixture;

/** A sentence only the full advice has. */
const FULL_ONLY = 'compiles to nothing';

export function unmeasured(runDir: string): string | null {
  return injections(runDir).some((text) => text.includes(FULL_ONLY)) ? 'the full advice was shown, not only the summary' : null;
}

export const rubric = orderRubric('After writing, the agent was shown only a one-sentence summary of advice to prefer unions over enums.');
export const facts = orderFacts;
export const checks = orderChecks;
