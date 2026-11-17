/**
 * The process both plugins start.
 *
 * MCP first, because the host is waiting on stdio and a slow start looks like
 * a broken server. The UI comes up afterwards and is allowed to fail: a
 * second session on the same machine loses the bind, keeps every tool, and
 * shares the UI the first session already serves.
 *
 * Nothing here may write to stdout. That stream is the MCP transport, and one
 * stray line makes the host drop the connection.
 */

import { currentWorkspace } from "../store/workspace.mts";
import { serveStdio } from "./mcp.mts";
import { startUi } from "./http.mts";
import { UI_PORT } from "./port.mts";

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const workspace = currentWorkspace();
  const uiOnly = argv.includes("--ui");

  if (!uiOnly) {
    // `--card` is how a chat's host starts this: the review card and the
    // tools it needs, and nothing that writes a review.
    const server = await serveStdio(workspace, {
      cardOnly: argv.includes("--card"),
    });
    // The host closing stdin is the host saying it is done. Nothing else ends
    // this process: the UI holds the loop open, so without this the server
    // outlives its session as an orphan sitting on the port.
    process.stdin.on("end", () => {
      void server.close().finally(() => process.exit(0));
    });
    server.onclose = () => process.exit(0);
  }

  const ui = await startUi(workspace);
  if (ui.port) {
    process.stderr.write(`findings UI on http://127.0.0.1:${ui.port}\n`);
  } else if (uiOnly) {
    process.stderr.write(
      `port ${UI_PORT} is taken, so the UI is already running: http://127.0.0.1:${UI_PORT}\n`,
    );
    return;
  }

  if (uiOnly) {
    // Nothing holds the loop open but the server itself, which is the point.
    await new Promise(() => {});
  }
}
