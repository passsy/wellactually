/**
 * What a worker thread of the hook runs: the isolate engine and nothing else.
 *
 * It is its own file because a worker loads its script from scratch. The
 * command carries the MCP server, the registry client and the authoring
 * tools, and a detector needs none of them.
 */
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { serveDetectors } from "../../board/src/pool.ts";

// Started as its own process with `--warm <socket>`, it is the warm pool the hooks share: see warm.ts.
if (isMainThread && process.argv[2] === "--warm") {
  const { runWarm } = await import("../../board/src/warm.ts");
  await runWarm(path.resolve(process.argv[1] as string), process.argv[3] as string);
} else {
  void serveDetectors();
}
