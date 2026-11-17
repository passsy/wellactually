/**
 * The browser inbox, started by `wellactually findings-ui`.
 *
 * The MCP tools are served by the plugin's own MCP server. This process only
 * holds the UI port; when another session already holds it, it says so and exits.
 */

import { currentWorkspace } from "../store/workspace.mts";
import { startUi } from "./http.mts";
import { UI_PORT } from "./port.mts";

export async function main(): Promise<void> {
  const ui = await startUi(currentWorkspace());
  if (!ui.port) {
    process.stderr.write(`port ${UI_PORT} is taken, so the UI is already running: http://127.0.0.1:${UI_PORT}\n`);
    return;
  }
  process.stderr.write(`findings UI on http://127.0.0.1:${ui.port}\n`);
  // Nothing holds the loop open but the server itself, which is the point.
  await new Promise(() => {});
}
