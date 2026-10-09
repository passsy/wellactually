/**
 * What a worker thread of the hook runs: the isolate engine and nothing else.
 *
 * It is its own file because a worker loads its script from scratch. The
 * command carries the MCP server, the registry client and the authoring
 * tools, and a detector needs none of them.
 */
import { serveDetectors } from "@wellactually/core/node";

void serveDetectors();
