/**
 * The triage UI, served from the same process as the MCP server.
 *
 * One fixed loopback port, never a random one, because the generated
 * review.html has to be able to find it without being told. Losing the bind
 * is the normal case rather than a failure: a second editor window starts a
 * second MCP server, the first one is already serving, and everything the
 * second one would have served is the same files on disk.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { watch, type FSWatcher } from "node:fs";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { GLOBAL_ROOT, REVIEW_DIR, targetPaths } from "../store/paths.mts";
import { UI_PORT } from "./port.mts";
import {
  documentPath,
  inboxUrlForLink,
  listDocuments,
  listFindings,
  listRepos,
  listReviews,
  markFindingsFollowed,
  markFindingsSeen,
  readDocument,
  readSource,
  setNote,
  setReported,
  setResolution,
  setStage,
  setVerdict,
} from "../api.mts";
import { appIcon } from "./icon.mts";
import { refreshAll, refreshPr, refreshSome, sweepPrs } from "../pr.mts";
import { MANIFEST, platform, restartCommand, serviceWorker } from "./pwa.mts";
import { listRules, readRule } from "../rules.mts";
import { toolNamed, TOOL_NAMES } from "../tools.mts";
import { inboxHtml, MissingWebBuild } from "./web-assets.mts";
import { escapeHtml, rulePage } from "../views/html.mts";
import type { Workspace } from "../store/workspace.mts";

/**
 * Who may talk to this server.
 *
 * A page on the open web can reach 127.0.0.1 as easily as a local file can,
 * and findings are code context. So the allowed origins are the generated
 * report opened from disk, which reports itself as "null", and the UI's own
 * origin. Everything else gets no CORS header and the browser stops it.
 */
function allowedOrigin(origin: string | undefined): string | null {
  if (!origin || origin === "null") return "null";
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))
    return origin;
  return null;
}

function cors(request: IncomingMessage, response: ServerResponse): void {
  const origin = allowedOrigin(request.headers.origin);
  if (!origin) return;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader(
    "access-control-allow-methods",
    "GET, POST, PATCH, OPTIONS",
  );
  response.setHeader("access-control-allow-headers", "content-type");
}

/**
 * Whether a request from another origin is refused before it does anything.
 *
 * CORS only stops a page reading the answer. A form posted from any site
 * still arrives and still runs, so a request that names an origin other than
 * ours is turned away here.
 */
function foreignRefused(request: IncomingMessage): boolean {
  return allowedOrigin(request.headers.origin) === null;
}

function send(
  response: ServerResponse,
  status: number,
  body: string,
  type = "application/json",
): void {
  response.writeHead(status, {
    "content-type": `${type}; charset=utf-8`,
    "cache-control": "no-store",
  });
  response.end(body);
}

/** Where a raw document request points, checked by the core's own rules. */
function fileOf(query: Record<string, unknown>, repo: string): string {
  const paths = targetPaths(
    typeof query["repo"] === "string" && query["repo"] !== ""
      ? query["repo"]
      : repo,
    String(query["target"] ?? ""),
  );
  return documentPath(paths, String(query["path"] ?? ""));
}

/**
 * Types a browser may render in place. Everything else is a download.
 *
 * These files are written by an agent into a directory this server hands to
 * a page on its own origin. A PDF or an image cannot script; SVG and HTML
 * can, so they leave as bytes with a name rather than as a document.
 */
const INLINE: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function sendFile(response: ServerResponse, file: string): void {
  const type = INLINE[extname(file).toLowerCase()];
  response.writeHead(200, {
    "content-type": type ?? "application/octet-stream",
    "content-disposition": type
      ? `inline; filename="${basename(file)}"`
      : `attachment; filename="${basename(file)}"`,
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(response);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    // A finding body is prose. Anything past this is not one.
    if (size > 1_000_000) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw === "" ? {} : JSON.parse(raw);
}

/** Query parameters and JSON body reach the core as the same shape. */
function fromQuery(url: URL): Record<string, unknown> {
  return Object.fromEntries(url.searchParams.entries());
}

class Clients {
  private readonly open = new Set<ServerResponse>();

  /**
   * When something last moved, for the pages that are not listening.
   *
   * A browser allows six connections to one origin and an event stream holds
   * one of them for as long as its tab is open, so a reader with a tab per
   * review runs out — and the seventh page hangs with no error, because the
   * requests queue rather than fail. So a page only streams while it is the
   * tab being looked at, and the rest ask this: one stamp, compared against
   * the last one they acted on. Same fact as the event, pulled instead of
   * pushed.
   *
   * Starts at the server's own start, which is a change from the point of
   * view of any page that was talking to whatever held this port before.
   */
  private at = new Date().toISOString();

  get changedAt(): string {
    return this.at;
  }

  add(response: ServerResponse): void {
    this.open.add(response);
    response.on("close", () => this.open.delete(response));
  }

  push(event: string, data: unknown): void {
    this.at = new Date().toISOString();
    // The stamp rides along, so a tab that streams and a tab that polls are
    // holding the same number and neither has to guess when it swaps over.
    const frame = `event: ${event}\ndata: ${JSON.stringify({ ...(data as object), at: this.at })}\n\n`;
    for (const response of this.open) response.write(frame);
  }

  closeAll(): void {
    for (const response of this.open) response.end();
    this.open.clear();
  }
}

/**
 * Watches every registered repository's review directory.
 *
 * The browser and an agent work the same queue at the same time, and the
 * agent writes files rather than calling the UI. Watching the files is the
 * only way the browser hears about that, and it catches this process's own
 * writes for free.
 */
class Watchers {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly clients: Clients;
  private timer: NodeJS.Timeout | null = null;

  constructor(clients: Clients) {
    this.clients = clients;
  }

  refresh(): void {
    const wanted = new Set(
      listRepos()
        .map((repo) => join(repo.path, REVIEW_DIR))
        .filter((dir) => existsSync(dir)),
    );
    if (existsSync(GLOBAL_ROOT)) wanted.add(GLOBAL_ROOT);

    for (const [dir, watcher] of this.watchers) {
      if (!wanted.has(dir)) {
        watcher.close();
        this.watchers.delete(dir);
      }
    }
    for (const dir of wanted) {
      if (this.watchers.has(dir)) continue;
      try {
        const watcher = watch(dir, { recursive: true }, () => this.beat(dir));
        watcher.on("error", () => {
          watcher.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, watcher);
      } catch {
        // An unwatchable directory costs live updates, not correctness.
      }
    }
  }

  /** One write touches the finding, the html and the sarif. Coalesce them. */
  private beat(dir: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (dir === GLOBAL_ROOT) this.refresh();
      this.clients.push("change", { dir });
    }, 120);
    this.timer.unref?.();
  }

  closeAll(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
}

export interface Ui {
  /** The port being served, or null while another process holds it. */
  port: number | null;
  close: () => Promise<void>;
}

/** How often a session that lost the port checks whether it is free again. */
const TAKEOVER_INTERVAL = 15_000;

/**
 * The version of the install this server started from, for /api/health.
 *
 * Sessions outlive plugin updates, so the process answering the port is not
 * necessarily the one just installed — and finding out which one it is used
 * to mean chasing pids. The package.json sits beside the bundle in a release
 * and names the runtime in a source checkout; either answer is the true one.
 */
let version: string | null | undefined;
function installedVersion(): string | null {
  if (version === undefined) {
    version = null;
    // Beside the bundle in a release; three levels up in the source tree. Read
    // the moment the server starts rather than on first ask, because by the
    // time an update has deleted this install there is nothing left to read
    // — and a server that cannot say its version is treated as the oldest.
    for (const at of [
      "../package.json",
      "../../package.json",
      "../../../package.json",
    ]) {
      try {
        version =
          (
            JSON.parse(readFileSync(new URL(at, import.meta.url), "utf8")) as {
              version?: string;
            }
          ).version ?? null;
        if (version) break;
      } catch {
        // The other candidate may still answer.
      }
    }
  }
  return version;
}

/**
 * Whether `mine` is a strictly newer release than `theirs`.
 *
 * Compared on the release triple alone — the codex build stamp after the `+`
 * orders nothing. A version that cannot be said is older than any that can:
 * the servers that predate saying one are exactly the old ones.
 */
function newer(mine: string | null, theirs: string | null): boolean {
  if (!mine) return false;
  if (!theirs) return true;
  const parse = (v: string): number[] =>
    (v.split("+")[0] ?? "").split(".").map(Number);
  const a = parse(mine);
  const b = parse(theirs);
  for (let i = 0; i < 3; i++) {
    const [x, y] = [a[i] ?? 0, b[i] ?? 0];
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Asks whoever holds the port to step aside, when they are older.
 *
 * True means the holder agreed and is closing, so a bind is worth retrying.
 * Everything else — a holder of the same or newer version, a holder too old
 * to know the route, nothing answering at all — is false, and the caller
 * waits its turn as before.
 */
async function evictOlder(): Promise<boolean> {
  const mine = installedVersion();
  if (!mine) return false;
  try {
    const health = (await (
      await fetch(`http://127.0.0.1:${UI_PORT}/api/health`, {
        signal: AbortSignal.timeout(1500),
      })
    ).json()) as { version?: string | null };
    if (!newer(mine, health.version ?? null)) return false;
    const asked = await fetch(`http://127.0.0.1:${UI_PORT}/api/yield`, {
      method: "POST",
      body: JSON.stringify({ version: mine }),
      signal: AbortSignal.timeout(1500),
    });
    if (!asked.ok) return false;
    // The holder closes after its response; give the port a moment to free.
    await new Promise((done) => setTimeout(done, 300));
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts the UI, or waits for a turn at it.
 *
 * Resolves with port null when the port stays taken, because that is the
 * ordinary outcome of a second session rather than a failure, and the tools
 * work either way. But the session holding the port is the one that ends
 * first as often as not, and until something rebinds, every open page is
 * looking at a server that no longer exists. So a process that loses the
 * bind keeps checking, and the last session standing ends up serving.
 *
 * A holder from an older install is not waited for: it is asked to yield, so
 * that installing a new version means seeing the new version, not the build
 * whichever session started first happened to load. A server asked to yield
 * gives up only the UI, keeps its tools, and joins this same waiting loop —
 * the roles swap, nothing is lost.
 */
export async function startUi(workspace: Workspace): Promise<Ui> {
  let live: { port: number; close: () => Promise<void> } | null = null;
  let retry: NodeJS.Timeout | null = null;
  let ended = false;

  const wait = (): void => {
    if (ended || retry) return;
    retry = setInterval(() => {
      // Only a server that can still show the page may take the port. A
      // plugin update deletes the old install out from under its running
      // sessions, and a survivor of that has nothing left to serve. Checked
      // every turn: a source checkout builds the web output after starting,
      // and from then on it is allowed to serve.
      if (!canServeInbox()) return;
      void take().then((got) => {
        if (got) {
          process.stderr.write(
            `findings UI taken over on http://127.0.0.1:${UI_PORT}\n`,
          );
        }
      });
    }, TAKEOVER_INTERVAL);
    // Waiting for a turn must not be a reason for this process to stay alive.
    retry.unref?.();
  };

  // Yielded to a newer install: back into the queue, in case this session
  // still outlives that one.
  const retire = (): void => {
    const was = live;
    live = null;
    void was?.close().then(wait);
  };

  const take = async (): Promise<boolean> => {
    let bound = await bindUi(workspace, retire);
    if (!bound && (await evictOlder())) bound = await bindUi(workspace, retire);
    if (!bound) return false;
    live = bound;
    if (retry) {
      clearInterval(retry);
      retry = null;
    }
    return true;
  };

  const got = await take();
  if (!got) wait();

  return {
    port: got ? UI_PORT : null,
    close: async () => {
      ended = true;
      if (retry) clearInterval(retry);
      await live?.close();
    },
  };
}

/**
 * Whether this process could answer "/" with the page rather than an apology.
 *
 * False means the built assets are unreadable from here — usually because the
 * install this server started from has been deleted by an update. The first
 * bind does not go through this: a source checkout that has not built yet
 * should come up and say which command to run.
 */
function canServeInbox(): boolean {
  try {
    inboxHtml();
    return true;
  } catch {
    return false;
  }
}

function bindUi(
  workspace: Workspace,
  retire: () => void,
): Promise<{ port: number; close: () => Promise<void> } | null> {
  const clients = new Clients();
  const watchers = new Watchers(clients);

  const server = createServer((request, response) => {
    cors(request, response);
    void handle(request, response, workspace, clients, retire).catch(
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        send(response, 400, JSON.stringify({ error: message }));
      },
    );
  });

  return new Promise((resolve) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      // Someone is already serving the same registry from the same port.
      // That is the intended outcome of a second session, not a crash.
      if (error.code === "EADDRINUSE") return resolve(null);
      resolve(null);
    });
    server.listen(UI_PORT, "127.0.0.1", () => {
      watchers.refresh();
      // Only the server holding the port sweeps: it is the one whose answers
      // anybody can see, and it stops the moment it hands the port on.
      const stopSweep = sweepPrs(() =>
        listReviews().map((review) => targetPaths(review.repo, review.target)),
      );
      resolve({
        port: UI_PORT,
        close: () =>
          new Promise<void>((done) => {
            stopSweep();
            watchers.closeAll();
            clients.closeAll();
            server.close(() => done());
          }),
      });
    });
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  workspace: Workspace,
  clients: Clients,
  retire: () => void,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${UI_PORT}`);
  const path = url.pathname;

  if (foreignRefused(request)) {
    send(
      response,
      403,
      JSON.stringify({ error: "not allowed from this origin" }),
    );
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (path === "/" || path === "/index.html") {
    // A source checkout that has not built the web output yet is a developer
    // one command away, not a broken install. Saying which command beats a
    // stack trace in a terminal they may not be looking at.
    //
    // The only HTML left written by hand, and it has to be: it is shown
    // exactly when the built components are missing, so it cannot be one of
    // them. Everything else a browser gets from here is rendered.
    try {
      send(response, 200, inboxHtml(), "text/html");
    } catch (error) {
      if (!(error instanceof MissingWebBuild)) throw error;
      send(
        response,
        503,
        `<!doctype html><meta charset="utf-8"><title>Review Inbox</title>
<body style="font:15px/1.6 system-ui;margin:3rem auto;max-width:34rem">
<h1 style="font-size:1.1rem">The triage page has not been built</h1>
<p>${escapeHtml(error.message)}</p>
<p>The tools and the API are unaffected; only this page is compiled.</p>`,
        "text/html",
      );
    }
    return;
  }

  // A review by a name that tells nothing: what the card opens through an
  // https redirect, since its host opens nothing that is not https.
  const link = /^\/open\/([0-9a-f]{16})(?:\/([A-Za-z0-9-]+))?$/.exec(path);
  if (link && request.method === "GET") {
    const to = inboxUrlForLink(link[1] ?? "", link[2]);
    if (to === null) {
      send(response, 404, "No review has this link.", "text/plain");
      return;
    }
    response.writeHead(302, { location: to, "cache-control": "no-store" });
    response.end();
    return;
  }

  if (path === "/api/health") {
    send(
      response,
      200,
      // Which plugin is answering, because both ship the same runtime and
      // either can hold this port. Anything asking whether the server is up
      // usually wants to know whose it is in the same breath.
      JSON.stringify({
        ok: true,
        port: UI_PORT,
        version: installedVersion(),
        platform: platform(),
        // What a page that is not holding an event stream open asks about.
        // Cheap on purpose: this route reads nothing and is the one a hidden
        // tab calls on a timer.
        changedAt: clients.changedAt,
        tools: TOOL_NAMES,
      }),
    );
    return;
  }

  /*
   * A newer install asking for the port. Sessions outlive plugin updates, so
   * the server holding the port is routinely older than the one just
   * installed — and before this route, every update ended with the page
   * still serving last week's build until somebody went hunting for pids.
   * Only a strictly newer release is yielded to; the holder gives up the UI
   * alone and keeps every tool, then waits its turn like any other loser of
   * the bind.
   */
  if (path === "/api/yield" && request.method === "POST") {
    const body = (await readBody(request)) as Record<string, unknown>;
    const theirs = typeof body["version"] === "string" ? body["version"] : null;
    if (!newer(theirs, installedVersion())) {
      send(
        response,
        409,
        JSON.stringify({
          error: `not newer than ${installedVersion() ?? "unversioned"}`,
        }),
      );
      return;
    }
    send(response, 200, JSON.stringify({ yielding: installedVersion() }));
    setTimeout(retire, 0);
    return;
  }

  // What a browser wants before it will give the page a window of its own.
  if (path === "/manifest.webmanifest") {
    send(response, 200, JSON.stringify(MANIFEST), "application/manifest+json");
    return;
  }

  if (path === "/sw.js") {
    // Generated per server, so the command it offers is the one that starts
    // this build rather than a guess written down at some earlier version.
    send(
      response,
      200,
      serviceWorker(restartCommand(process.argv[1], platform()), platform()),
      "text/javascript",
    );
    return;
  }

  // Drawn on request rather than kept as a file. It costs a few milliseconds
  // once per install and saves a binary nobody could review or resize.
  const icon = /^\/icon-(\d{2,4})\.png$/.exec(path);
  if (icon) {
    const size = Number(icon[1]);
    if (size < 16 || size > 1024) {
      send(response, 404, JSON.stringify({ error: "no icon that size" }));
      return;
    }
    response.writeHead(200, {
      "content-type": "image/png",
      // The only thing this server serves that cannot go stale: it is a
      // function of its own size and nothing else.
      "cache-control": "public, max-age=604800",
    });
    response.end(appIcon(size));
    return;
  }

  if (path === "/api/repos") {
    send(response, 200, JSON.stringify(listRepos()));
    return;
  }

  // The same reviews with everything the list needs to be chosen from: what
  // the pull request is, how much of it is unread, and how much is left.
  if (path === "/api/reviews") {
    const reviews = listReviews();
    send(response, 200, JSON.stringify(reviews));
    // And then, behind the answer that already went out, a few of the pull
    // requests get asked whether they have landed. Behind it on purpose: this
    // list is drawn on every page load and a forge is a network away, so the
    // page must never be waiting on one. Anything that comes back is written
    // to the review's own file, which the watcher above turns into the change
    // event the page is already listening for.
    void refreshSome(
      reviews.map((review) => targetPaths(review.repo, review.target)),
    );
    return;
  }

  /*
   * Ask the forge now, and say what came back.
   *
   * The sweep runs on its own and writes only when something changed, which
   * is right and is also invisible: press nothing, see nothing, and there is
   * no way to tell a working check from one that has been silently answering
   * "no" since it was installed. This is the same check with its reasons
   * showing — the one review named, or all of them.
   */
  if (path === "/api/pr/refresh" && request.method === "POST") {
    const body = (await readBody(request)) as Record<string, unknown>;
    const repo = typeof body["repo"] === "string" ? body["repo"] : null;
    const target = typeof body["target"] === "string" ? body["target"] : null;
    const wanted =
      repo && target
        ? [targetPaths(repo, target)]
        : listReviews().map((review) =>
            targetPaths(review.repo, review.target),
          );
    send(response, 200, JSON.stringify({ checked: await refreshAll(wanted) }));
    return;
  }

  // A finding cites rules by id, and an id is only worth writing if the reader
  // can reach the rule behind it. Two doors on the same lookup: the triage
  // page opens it in its panel, the generated report has no panel and opens
  // the page below in a tab.
  if (path === "/api/rule" && request.method === "GET") {
    const rule = readRule(url.searchParams.get("id") ?? "");
    if (!rule) {
      send(
        response,
        404,
        JSON.stringify({ error: `no rule ${url.searchParams.get("id")}` }),
      );
      return;
    }
    send(response, 200, JSON.stringify(rule));
    return;
  }

  if (path === "/api/rules" && request.method === "GET") {
    send(
      response,
      200,
      JSON.stringify(
        listRules(
          url.searchParams.get("repo") ?? workspace.repo,
          url.searchParams.get("includeDisabled") === "true",
        ),
      ),
    );
    return;
  }

  const named = /^\/rule\/([A-Za-z0-9-]+)$/.exec(path);
  if (named && request.method === "GET") {
    const rule = readRule((named[1] ?? "").toUpperCase());
    if (!rule) {
      send(response, 404, `No rule ${named[1]}.`, "text/plain");
      return;
    }
    send(response, 200, rulePage(rule), "text/html");
    return;
  }

  // The panel that shows a whole file. Read-only, and the core decides what
  // may be read; this route only hands over the query.
  if (path === "/api/file" && request.method === "GET") {
    send(
      response,
      200,
      JSON.stringify(readSource(fromQuery(url), workspace.repo)),
    );
    return;
  }

  // The documents the review wrote by hand, which are the argument the
  // findings are the conclusions of.
  if (path === "/api/docs" && request.method === "GET") {
    send(
      response,
      200,
      JSON.stringify(listDocuments(fromQuery(url), workspace.repo)),
    );
    return;
  }

  if (path === "/api/doc" && request.method === "GET") {
    send(
      response,
      200,
      JSON.stringify(readDocument(fromQuery(url), workspace.repo)),
    );
    return;
  }

  // The generated report, for the README that links it. Every review is told
  // to write that link, and the document routes refuse it: being generated is
  // the right reason to keep it out of a list of what the review wrote, and
  // the wrong reason to refuse a link somebody put there on purpose.
  //
  // Its own route rather than the raw one, because this is a page this code
  // generated and hands to a browser to render, not an agent's attachment
  // being handed over as bytes.
  if (path === "/review.html" && request.method === "GET") {
    const paths = targetPaths(
      url.searchParams.get("repo") || workspace.repo,
      url.searchParams.get("target") ?? "",
    );
    if (!existsSync(paths.html)) {
      send(response, 404, `No report for ${paths.target} yet.`, "text/plain");
      return;
    }
    send(response, 200, readFileSync(paths.html, "utf8"), "text/html");
    return;
  }

  // An attachment next to a level document: a PDF, a screenshot, whatever the
  // review put there. Served as bytes so a browser can open it.
  if (path === "/api/doc/raw" && request.method === "GET") {
    sendFile(response, fileOf(fromQuery(url), workspace.repo));
    return;
  }

  if (path === "/api/findings" && request.method === "GET") {
    // With the code, unlike the tool of the same name. The page renders that
    // code, it holds the whole target at once to mark every finding that
    // touches an open file, and a browser has no context window to spend.
    const asked = fromQuery(url);
    send(
      response,
      200,
      JSON.stringify(listFindings({ ...asked, code: true }, workspace.repo)),
    );
    // The review somebody just opened is the one whose pull request matters
    // now, and it is exactly one call. Whether it landed while they were
    // reading is the question the banner exists to answer.
    const repo = typeof asked["repo"] === "string" ? asked["repo"] : null;
    const target = typeof asked["target"] === "string" ? asked["target"] : null;
    if (repo && target) void refreshPr(targetPaths(repo, target));
    return;
  }

  // One route per axis, because they are separate answers with different
  // people behind them, and a browser only ever speaks for the human.
  // "stage" is the page's own: it is the track the browser draws, composed of
  // the axes below it, and no tool call thinks in those terms.
  const axis =
    /^\/api\/findings\/([^/]+)\/(verdict|resolution|reported|stage)$/.exec(
      path,
    );
  if (axis && (request.method === "PATCH" || request.method === "POST")) {
    const body = (await readBody(request)) as Record<string, unknown>;
    const move =
      axis[2] === "verdict"
        ? setVerdict
        : axis[2] === "reported"
          ? setReported
          : axis[2] === "stage"
            ? setStage
            : setResolution;
    const updated = move(
      {
        ...body,
        id: decodeURIComponent(axis[1] ?? ""),
        actor: body["actor"] ?? "human",
      },
      workspace.repo,
    );
    send(response, 200, JSON.stringify(updated));
    return;
  }

  // Read receipts. Only the page sends them, so there is no tool of this name
  // and the route stands on its own rather than going through the bridge.
  if (path === "/api/follow" && request.method === "POST") {
    const body = (await readBody(request)) as Record<string, unknown>;
    send(
      response,
      200,
      JSON.stringify(markFindingsFollowed(body, workspace.repo)),
    );
    return;
  }

  if (path === "/api/seen" && request.method === "POST") {
    const body = (await readBody(request)) as Record<string, unknown>;
    send(response, 200, JSON.stringify(markFindingsSeen(body, workspace.repo)));
    return;
  }

  // Typed rather than submitted: the UI saves the note while it is being
  // written, so this route is hit far more often than any other and does the
  // one thing it does.
  const note = /^\/api\/findings\/([^/]+)\/note$/.exec(path);
  if (note && (request.method === "PATCH" || request.method === "POST")) {
    const body = (await readBody(request)) as Record<string, unknown>;
    const updated = setNote(
      { ...body, id: decodeURIComponent(note[1] ?? "") },
      workspace.repo,
    );
    send(response, 200, JSON.stringify(updated));
    return;
  }

  // The same operations the MCP tools expose, for anything the UI does not
  // have a dedicated endpoint for. One core, two doors, no second dispatch.
  const tool = /^\/api\/tools\/([a-z_]+)$/.exec(path);
  if (tool && request.method === "POST") {
    const named = toolNamed(tool[1] ?? "");
    if (!named) {
      send(response, 404, JSON.stringify({ error: `no tool "${tool[1]}"` }));
      return;
    }
    const result = await named.run(await readBody(request), workspace.repo);
    send(response, 200, JSON.stringify(result));
    return;
  }

  if (path === "/api/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    response.write("retry: 2000\n\n");
    clients.add(response);
    return;
  }

  send(response, 404, JSON.stringify({ error: `no route ${path}` }));
}
