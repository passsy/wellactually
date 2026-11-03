/**
 * The Review Inbox, served from the working tree.
 *
 * `npm run ui` from the repository root. The point is the loop: edit a file
 * under runtime/, node's --watch restarts this process, and the next refresh
 * of http://127.0.0.1:8424 is the change. No build, no release, no plugin
 * install standing between writing a line and looking at it.
 *
 * The UI only. There is no MCP host on the other end of stdio here, and a
 * server that spoke the protocol to a terminal would fail in a way that
 * looked like the UI failing.
 *
 * It reads the same files every other copy reads, so the reviews on the page
 * are the real ones. What it is not is a place to leave running: it holds the
 * one port a session would otherwise take, and it serves whatever the working
 * tree says right now, including the half of a change that is not finished.
 */

import { startUi } from "./http.mts";
import { UI_PORT } from "./port.mts";
import { currentWorkspace } from "../store/workspace.mts";

const ui = await startUi(currentWorkspace());
if (ui.port) {
  process.stderr.write(
    `Review Inbox on http://127.0.0.1:${ui.port} — from the working tree\n`,
  );
} else {
  process.stderr.write(
    `port ${UI_PORT} is taken by another findings server, probably a session's own. Stop that one and this takes over within fifteen seconds.\n`,
  );
}

// Held open deliberately, and this is not decoration. Losing the bind leaves
// nothing else keeping the loop alive, so without this the process exits the
// moment another server has the port — and node's --watch then sits waiting
// for a file change, so the next edit appears to do nothing at all. What is
// wanted instead is a process that waits its turn, because the holder is
// usually a session that is about to end.
const held = setInterval(() => {}, 1 << 30);

// --watch restarts the process, which means this one has to let go of the
// port on its way out. Without this the restart finds its own corpse holding
// the bind and quietly serves nothing.
for (const signal of ["SIGINT", "SIGTERM", "SIGUSR2"] as const) {
  process.once(signal, () => {
    clearInterval(held);
    void ui.close().finally(() => process.exit(0));
  });
}
