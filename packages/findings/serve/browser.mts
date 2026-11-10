/**
 * Opens a URL in the browser of the machine this server runs on.
 *
 * The review card's Inbox button, in a host that carries its tool calls. The
 * host's own way to open a link refuses anything but https, and the inbox is
 * http on loopback. This server is on the same machine as the person looking
 * at the card, so it can open the page itself.
 *
 * WELLACTUALLY_REVIEW_BROWSER replaces the command, which is how tests stay out of
 * the browser.
 */

import { spawn } from "node:child_process";

export function openInBrowser(url: string): void {
  const override = process.env.WELLACTUALLY_REVIEW_BROWSER ?? process.env.PASCAL_REVIEW_BROWSER;
  const [command, ...args] = override
    ? [override, url]
    : process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  const child = spawn(command ?? "open", args, {
    detached: true,
    stdio: "ignore",
  });
  // Nothing is waiting on a browser, and a missing command is not this
  // process's crash.
  child.on("error", () => {});
  child.unref();
}
