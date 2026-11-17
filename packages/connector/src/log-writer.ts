/**
 * What the hook starts after it has answered the agent: writes one entry of
 * the hook log, given on standard input, into the directory given as argument.
 *
 * It is its own small file so that writing a log line does not load the
 * whole command.
 */
import { writeHookLogFromStdin } from "./hook/hook-log.ts";

const dir = process.argv[2];
if (dir) {
  writeHookLogFromStdin(dir).catch(() => {});
}
