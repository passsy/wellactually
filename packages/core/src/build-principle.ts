/**
 * Builds the principle in a directory and prints it as JSON.
 *
 * A test's `detect()` has to answer at once, and building is asynchronous.
 * So the SDK runs this file as a child process and waits for it, which is the
 * one way Node offers to wait. It prints `{ built, files }`, or `{ error }`
 * with a message for the author.
 */
import { buildPrinciple, readPrinciple } from "./node.ts";

const dir = process.argv[2];
let out: unknown;
try {
  if (!dir) {
    throw new Error("usage: build-principle <dir>");
  }
  // With the code of the packages it imports, taken from node_modules, as a submit does.
  const files = await readPrinciple(dir);
  out = { built: await buildPrinciple(files), files };
} catch (error) {
  out = { error: error instanceof Error ? error.message : String(error) };
}
process.stdout.write(JSON.stringify(out));
