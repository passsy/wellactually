/**
 * What `vitest` resolves to when a principle's tests run inside the isolate.
 *
 * An author runs the tests with vitest itself. The registry cannot: it runs
 * code from strangers, and only inside the isolate. So it gives the tests the
 * part of vitest's API a detector test needs. An import of anything else
 * fails the build with the name that is missing.
 */
export { describe, expect, it, test } from "./test.ts";
