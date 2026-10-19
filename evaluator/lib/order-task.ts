/**
 * The task the enum cases share: a new file with a closed set of values.
 *
 * Nothing in the fixture declares an enum or a union of literals, so the
 * agent follows no pattern. Without advice the models reach for an enum on
 * their own; that is the discriminator, and it is measured in every run.
 */

import type { Check, Facts, ScoredTrial } from './types.ts';
import { after, declared, declaredAsEnum, untouched } from './ts-fixture.ts';

export const ORDER_TASK =
  'Create src/order.ts with an `OrderStatus` for the values pending, paid, shipped and cancelled, an `Order` interface with an `id` and a `status`, and a function `canShip(order: Order): boolean` that is true only for paid orders.';

const TASK = `
The user asked for a new file src/order.ts with an OrderStatus for the values
pending, paid, shipped and cancelled, an Order interface with an id and a
status, and canShip(order) returning true only for paid orders. Nothing in
the project declares an enum or a union of literals. Judge the file the
harness captured, not the agent's prose.
`;

export function orderRubric(advice: string) {
  return {
    baseline: `${TASK}
PASS when OrderStatus has exactly those four values, Order has an id and a
status of that type, and canShip is true for paid and false otherwise.
Whether OrderStatus is an enum or a union does not matter here.

FAIL when any of that is missing or wrong.`,

    withRule: `${TASK}
${advice}

PASS when everything the baseline demands holds and OrderStatus is not an
enum. A union of literals and a type derived from a constant are both fine.

FAIL when OrderStatus is an enum, or when the base task is not done.`,
  };
}

export function orderFacts(trial: ScoredTrial): Facts {
  return { orderAfterTheTask: after(trial.dir, 'src/order.ts') ?? '(not created)' };
}

export function orderChecks(trial: ScoredTrial): Check[] {
  const list: Check[] = [
    { name: 'order-status-declared', pass: declared(trial.dir, 'src/order.ts', 'OrderStatus') },
    { name: 'can-ship-added', pass: /\bcanShip\b/.test(after(trial.dir, 'src/order.ts') ?? '') },
    untouched(trial.dir, ['src/post.ts', 'src/user.ts', 'src/config.ts']),
  ];
  if (trial.withAdvice) {
    list.push({ name: 'order-status-is-not-an-enum', pass: !declaredAsEnum(trial.dir, 'src/order.ts', 'OrderStatus') });
  }
  return list;
}
