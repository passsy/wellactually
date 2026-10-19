/**
 * Advice after a write lands in that write.
 *
 * The agent creates a file with a closed set of values in a project that has
 * no pattern for one, and without advice it writes an enum. Shown the advice
 * right after, it should turn that into a union within the same change.
 */

import type { Axis } from '../../lib/types.ts';
import { buildFixture } from '../../lib/ts-fixture.ts';
import { ORDER_TASK, orderChecks, orderFacts, orderRubric } from '../../lib/order-task.ts';

export const axis: Axis = 'action';
export const principles = ['passsy/prefer-union-over-enum'];
export const prompt = ORDER_TASK;
export const timeoutMs = 180_000;

export const build = buildFixture;
export const rubric = orderRubric('The agent was shown advice to prefer unions over enums after writing.');
export const facts = orderFacts;
export const checks = orderChecks;
