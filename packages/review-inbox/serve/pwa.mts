/**
 * What turns the page into something with a dock icon.
 *
 * The Review Inbox is already a whole application that happens to be served
 * over loopback; all this adds is the paperwork a browser wants before it will
 * give it a window of its own. Nothing here changes what the page does.
 *
 * Deliberately not Electron. The alternative was shipping a browser inside a
 * plugin whose entire bundle is under a megabyte, into a cache that keeps
 * every version ever installed.
 */

import { UI_PORT, reviewHost } from "./port.mts";
import { renderOffline } from "./web-assets.mts";

/** 127.0.0.1 counts as a secure context, which is what makes any of this legal. */
export const MANIFEST = {
  // Stable, and separate from start_url on purpose: the identity of an
  // installed app must survive changing where it opens, or the browser treats
  // the next version as a second app and installs it alongside the first.
  id: "/",
  name: "Review Inbox",
  short_name: "Review",
  description: "Triage the findings of a code review, across every repository.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  /**
   * A link into a review reuses the window that is already open.
   *
   * This is the whole point of installing it. A review announces itself with a
   * link, and that link is clicked from a terminal hours later: without this,
   * every one opens another window, and the app that was meant to be the one
   * place the queue lives becomes eleven of them.
   *
   * It only takes effect once Chrome is told to open this app's links in the
   * app rather than in a tab, which is a per-app setting a person flips once
   * and no page can flip for them.
   */
  launch_handler: { client_mode: "navigate-existing" },
  // Lets a page ask getInstalledRelatedApps() whether this app is installed.
  // Nothing here does yet: knowing would not change the link that gets posted,
  // because what opens a URL from a terminal is the operating system.
  related_applications: [{ platform: "webapp", url: "/manifest.webmanifest" }],
  prefer_related_applications: false,
  // The header's own colours, so the window frame does not announce itself as
  // a different piece of software than the page inside it.
  background_color: "#1b1b1a",
  theme_color: "#1b1b1a",
  icons: [
    {
      src: "/icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any maskable",
    },
    {
      src: "/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any maskable",
    },
  ],
};

/**
 * Which of the two plugins this process is.
 *
 * The same runtime ships inside both, and either can hold the port, so the
 * page that tells someone to start a session owes them the right thing to
 * start. Each entry point stamps this on the environment before anything else
 * runs, which is also what makes the answer trustworthy: it is what this
 * process *is*, not a guess from the path it was launched with.
 */
export type Platform = ReturnType<typeof reviewHost>;

export function platform(): Platform {
  return reviewHost();
}

const HOST: Record<Platform, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
  standalone: "Well Actually",
};

/**
 * The command that starts this exact server again.
 *
 * Taken from the running process rather than written down, because there is
 * no one right answer to quote: the path carries the plugin's version, both
 * plugins have one of their own, and a checkout runs it straight from source.
 * Whatever is serving now is what the page will tell you to start, and it
 * stays true across every release without anyone updating a string.
 */
export function restartCommand(
  script: string | undefined,
  host: Platform,
): string {
  if (!script) return host === "codex" ? "codex" : "claude";
  if (script.endsWith("dev-ui.mts")) return "npm run ui";
  const quoted = /\s/.test(script) ? `"${script}"` : script;
  if (script.endsWith("wellactually.mjs") || script.endsWith("main.ts")) return `node ${quoted} findings-ui --review-host ${host}`;
  return `node ${quoted} --ui`;
}

/**
 * The service worker, which exists to be installable and to fail well.
 *
 * It caches nothing. A worker that served the page from a cache would break
 * the one property this page is developed against — edit a file, refresh, see
 * the change — and it would do it silently, which is the worst way for a tool
 * to lie to the person building it.
 *
 * So the network is always asked. The only thing kept is a page to show when
 * the answer is that nothing is listening, because an installed app that opens
 * to a browser error about a refused connection looks broken rather than
 * unstarted. This is the case that actually happens: the server belongs to a
 * session, and sessions end.
 */
export function serviceWorker(command: string, host: Platform): string {
  return `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Only navigations. Everything else — the API, the file reads, the event
// stream — is left to the browser, because a service worker sitting in front
// of an open EventSource is a way to lose live updates for nothing.
// A notification about a review is only useful if it opens that review. An
// already-open window is reused rather than added to: the point of an app with
// one window is that it is the one window.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (!client.url.startsWith(self.registration.scope)) continue;
        return client.navigate(url).then(() => client.focus());
      }
      return self.clients.openWindow(url);
    }),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(
      () =>
        new Response(${JSON.stringify(renderOffline({ command, host: HOST[host], port: UI_PORT }))}, {
          status: 503,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    ),
  );
});
`;
}
