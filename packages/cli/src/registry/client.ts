import { hashPrinciple, type BoardPrinciple, type CheckReport, type PrincipleFiles, type ReleasedBundle } from "@wellactually/core/node";
import { hasCached, readConfig, readLockfile, tokenFromEnvironment, writeCached, writeConfig, writeLockfile } from "../board/board.ts";
import { drainDetections } from "../board/detections.ts";
import type { Rater } from "./rater.ts";

export class RegistryError extends Error {
  /** The HTTP status the registry answered with, or null when it was not asked or did not answer. */
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

async function call(pathname: string, init: { method?: string; body?: unknown; token?: string | null } = {}): Promise<Response> {
  const config = readConfig();
  const token = init.token === undefined ? config.token : init.token;
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const url = new URL(pathname, config.registry);
  // The registry sleeps when idle. Its first request may come back as 502 from
  // the platform, or as 503 while its database wakes. Neither was processed,
  // so asking again is safe for every call, uploads included.
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch (error) {
      throw new RegistryError(`cannot reach the registry at ${config.registry}: ${(error as Error).message}`);
    }
    if ((response.status !== 502 && response.status !== 503) || attempt === WAKE_RETRIES.length) {
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, WAKE_RETRIES[attempt]));
  }
}

/** Pauses between attempts while the registry wakes up, in milliseconds. */
const WAKE_RETRIES = [1000, 2000, 4000];

/** How long a 429 or 503 asks the client to wait, in milliseconds. Zero when it does not say. */
function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

async function failure(response: Response): Promise<RegistryError> {
  if (response.status === 401) {
    if (tokenFromEnvironment()) {
      return new RegistryError("the registry refused the token in WELLACTUALLY_TOKEN. It was revoked or is mistyped. Create a new one on your advisory board on the website.", 401);
    }
    return new RegistryError("not signed in, or the token was revoked. Sign in with the plugin's login skill.");
  }
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return new RegistryError(body?.error ?? `the registry answered ${response.status}`, response.status);
}

function requireToken(): void {
  if (!readConfig().token) {
    throw new RegistryError("not signed in. Sign in with the plugin's login skill.");
  }
}

/** What a sync of a repository made of one principle folder. */
export interface SyncedPrinciple {
  slug: string;
  path: string;
  status: "draft" | "released" | "unchanged" | "failed";
  version: number | null;
  problems: string[];
}

export interface RepositorySync {
  repository: string;
  handle: string;
  commit: string;
  principles: SyncedPrinciple[];
}

/** Asks the registry to read a connected repository now. */
export async function syncRepository(name: string): Promise<RepositorySync> {
  requireToken();
  const response = await call("/api/repositories/sync", { method: "POST", body: { repository: name } });
  if (!response.ok) {
    throw await failure(response);
  }
  return (await response.json()) as RepositorySync;
}

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_url: string;
  interval: number;
  expires_in: number;
}

export async function startDeviceLogin(): Promise<DeviceStart> {
  const response = await call("/api/device/start", { method: "POST", body: {}, token: null });
  if (!response.ok) {
    throw await failure(response);
  }
  return (await response.json()) as DeviceStart;
}

/** Waits for the user to confirm the code in the browser, then stores the token. */
export async function finishDeviceLogin(start: DeviceStart): Promise<string> {
  const deadline = Date.now() + start.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, start.interval * 1000));
    let response: Response;
    try {
      response = await call("/api/device/poll", { method: "POST", body: { device_code: start.device_code }, token: null });
    } catch (error) {
      // The user may take minutes to confirm, and a laptop changes networks or sleeps meanwhile. One poll that gets
      // no answer says nothing about the code, so the login keeps waiting until it expires.
      if (error instanceof RegistryError) {
        continue;
      }
      throw error;
    }
    if (response.status === 202 || response.status >= 500) {
      continue;
    }
    if (response.status === 429) {
      // Several logins behind one address can use up the registry's limit on polls. It says how long to stay quiet.
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs(response)));
      continue;
    }
    if (!response.ok) {
      throw await failure(response);
    }
    const { token, handle } = (await response.json()) as { token: string; handle: string };
    writeConfig({ ...readConfig(), token, handle });
    return handle;
  }
  throw new RegistryError("the code expired before it was confirmed. Sign in again with the plugin's login skill.");
}

export function logout(): void {
  writeConfig({ ...readConfig(), token: null, handle: null });
}

export async function whoami(): Promise<string> {
  requireToken();
  const response = await call("/api/me");
  if (!response.ok) {
    throw await failure(response);
  }
  return ((await response.json()) as { handle: string }).handle;
}

export interface DraftResult {
  /** False when the registry's own check refused the upload. */
  accepted: boolean;
  id: string | null;
  version: number | null;
  /** The principle's page. */
  url: string | null;
  report: CheckReport;
  /** Whether the registry released it. A registry from before uploads released leaves it out. */
  released?: boolean;
  /** Why it stays a draft, when it does, for instance a package licence that holds it back. */
  held?: string | null;
  /** Who can see it after the upload. A registry from before uploads took a visibility leaves it out. */
  visibility?: Visibility | null;
  /** Whether it becomes public with its first release, because public was asked for before it had one. */
  publicOnRelease?: boolean;
  /** Why the visibility the upload asked for was not applied, for instance a package.json that sets it. */
  visibilityRefused?: string | null;
}

export type Visibility = "public" | "private";

/**
 * Uploads a principle as the next revision of `slug` and releases it. The registry rebuilds it and reruns the tests.
 *
 * `approved` names the packages the expert approved. The registry works out
 * itself which packages need that, and refuses the draft when one is missing.
 * `visibility`, when given, sets who can see it, as the website's switch does.
 */
export async function publishDraft(slug: string, files: PrincipleFiles, approved: string[] = [], visibility?: Visibility): Promise<DraftResult> {
  requireToken();
  const response = await call("/api/drafts", { method: "POST", body: { slug, files, approved, visibility } });
  if (response.status !== 201 && response.status !== 422) {
    throw await failure(response);
  }
  const body = (await response.json()) as Omit<DraftResult, "accepted">;
  return { ...body, accepted: response.status === 201 };
}

/** An expert the registry suggests while the advisory board is empty. */
export interface SuggestedExpert {
  handle: string;
  name: string;
  principles: number;
  /** The titles of a few of their principles. */
  tips: string[];
  /** Their page on the website, where the user adds them. */
  url: string;
}

export interface SyncResult {
  entries: BoardPrinciple[];
  downloaded: string[];
  removed: string[];
  /** Detections reported to the registry with this sync. */
  reported: number;
  /** Experts to follow, when the advisory board on the registry is empty. */
  suggestions: SuggestedExpert[];
}

/**
 * Brings the local advisory board in line with the one on the registry.
 *
 * Bundles are immutable and keyed by hash, so only the ones this machine has
 * never seen are downloaded. Each download is rehashed before it is stored:
 * what runs in the hook is what the user accepted on the website, or nothing.
 * Principles added from a local directory are kept as they are.
 */
export async function sync(): Promise<SyncResult> {
  requireToken();
  const response = await call("/api/board");
  if (!response.ok) {
    throw await failure(response);
  }
  const body = (await response.json()) as { entries: BoardPrinciple[]; suggestions?: Omit<SuggestedExpert, "url">[] };
  const remote = body.entries;
  const registry = readConfig().registry;
  const suggestions = (body.suggestions ?? []).map((expert) => ({ ...expert, url: new URL(`/e/${encodeURIComponent(expert.handle)}`, registry).toString() }));

  const downloaded: string[] = [];
  for (const entry of remote) {
    if (hasCached(entry.hash)) {
      continue;
    }
    const bundleResponse = await call(`/api/bundles/${entry.hash}`);
    if (!bundleResponse.ok) {
      throw await failure(bundleResponse);
    }
    const principle = (await bundleResponse.json()) as ReleasedBundle;
    const actual = await hashPrinciple(principle.manifest, principle.advice, principle.bundle);
    if (actual !== entry.hash) {
      throw new RegistryError(`${entry.id} does not match its hash. Refusing to install it.`);
    }
    writeCached({ id: entry.id, version: entry.version, hash: entry.hash, manifest: principle.manifest, advice: principle.advice, bundle: principle.bundle });
    downloaded.push(entry.id);
  }

  const before = readLockfile();
  const local = before.entries.filter((entry) => entry.id.startsWith("local/"));
  const remoteIds = new Set(remote.map((entry) => entry.id));
  const removed = before.entries
    .filter((entry) => !entry.id.startsWith("local/") && !remoteIds.has(entry.id))
    .map((entry) => entry.id);
  const synced = remote.map(({ id, version, hash, enabled }) => ({ id, version, hash, enabled }));
  writeLockfile({ syncedAt: new Date().toISOString(), entries: [...synced, ...local] });
  return { entries: remote, downloaded, removed, reported: await reportDetections(), suggestions };
}

/**
 * Sends how often each principle fired since it last sent: a day, a hash and a count.
 * A sync does it, and the hook a few minutes after something fired.
 *
 * It is a courtesy to the authors, so it never fails a sync. What could not
 * be sent stays on disk and goes out next time.
 */
export async function reportDetections(): Promise<number> {
  if (!readConfig().stats) {
    return 0;
  }
  try {
    return await drainDetections(async (detections) => {
      const response = await call("/api/detections", { method: "POST", body: { detections } });
      if (!response.ok) {
        throw await failure(response);
      }
    });
  } catch {
    return 0;
  }
}

export interface PulledSource {
  id: string;
  version: number;
  status: "draft" | "released";
  files: PrincipleFiles;
  /** Who it is by: the expert of the original first, then each who forked it. Absent from registries before forks were credited. */
  credits?: string[];
  /** Who can read it. Absent from registries before the show tool. */
  visibility?: Visibility;
}

/** Splits `expert/principle@3` into its parts. A bare principle id means one of the user's own. */
function parseId(id: string): { handle: string; slug: string; version: number | null } {
  const [name = "", versionText] = id.split("@");
  const full = name.includes("/") ? name : `${readConfig().handle ?? ""}/${name}`;
  const [handle, slug, ...rest] = full.split("/");
  const version = versionText === undefined ? null : Number(versionText.replace(/^v/, ""));
  if (!handle || !slug || rest.length > 0 || (version !== null && (!Number.isInteger(version) || version < 1))) {
    throw new RegistryError(`"${id}" is not a principle id. Use expert/principle, optionally with @revision, or just the principle for one of your own.`);
  }
  return { handle, slug, version };
}

/** Downloads a principle's files: a given revision, else your own draft when one is waiting, else the newest release. */
export async function pullSource(id: string): Promise<PulledSource> {
  const { handle, slug, version } = parseId(id);
  const query = version === null ? "" : `?version=${version}`;
  const response = await call(`/api/principles/${encodeURIComponent(handle)}/${encodeURIComponent(slug)}/source${query}`);
  if (!response.ok) {
    throw await failure(response);
  }
  return (await response.json()) as PulledSource;
}

export interface HistoryEntry {
  version: number;
  hash: string;
  status: "draft" | "released";
  date: string;
  changed: { path: string; change: "added" | "modified" | "removed" }[];
}

export interface History {
  id: string;
  visibility: "private" | "public";
  history: HistoryEntry[];
}

/** A principle's versions, newest first. */
export interface ReleaseResult {
  id: string;
  version: number;
  url: string;
}

/** Releases the waiting draft of one of the user's own principles, such as one an earlier upload or the website left. */
export async function releaseDraft(id: string): Promise<ReleaseResult> {
  requireToken();
  const { handle, slug } = parseId(id);
  const response = await call(`/api/principles/${encodeURIComponent(handle)}/${encodeURIComponent(slug)}/release`, { method: "POST" });
  if (!response.ok) {
    throw await failure(response);
  }
  return (await response.json()) as ReleaseResult;
}

export interface VisibilityResult {
  id: string;
  visibility: Visibility;
  /** Whether it becomes public with its first release, because it has none yet. */
  publicOnRelease: boolean;
  url: string;
}

/** Sets who can see one of the user's own principles. A package.json that sets its visibility wins, and the registry refuses then. */
export async function setVisibility(id: string, visibility: Visibility): Promise<VisibilityResult> {
  requireToken();
  const { handle, slug } = parseId(id);
  const response = await call(`/api/principles/${encodeURIComponent(handle)}/${encodeURIComponent(slug)}/visibility`, { method: "POST", body: { visibility } });
  if (!response.ok) {
    throw await failure(response);
  }
  return (await response.json()) as VisibilityResult;
}

export async function fetchHistory(id: string): Promise<History> {
  const { handle, slug } = parseId(id);
  const response = await call(`/api/principles/${encodeURIComponent(handle)}/${encodeURIComponent(slug)}/history`);
  if (!response.ok) {
    throw await failure(response);
  }
  return (await response.json()) as History;
}

export type Rating = "up" | "down" | "not_applicable";

/**
 * Sends an agent's verdict on a principle on this machine's advisory board.
 *
 * The verdict is about the revision the agent was shown, so the id is resolved
 * through the local advisory board, not through the registry's newest release.
 * The rater says which agent and model gave it, as the agent reported them.
 * Returns what to tell the agent.
 */
export async function ratePrinciple(id: string, rating: Rating, rater: Rater = { agent: null, model: null }): Promise<string> {
  if (id.startsWith("local/")) {
    return `${id} is a local principle. It belongs to no registry, so there is nobody to send a rating to.`;
  }
  if (!readConfig().stats) {
    return "Reporting is turned off on this machine, so the rating was not sent.";
  }
  const entry = readLockfile().entries.find((candidate) => candidate.id === id);
  if (!entry) {
    return `${id} is not on this advisory board. Use the id from the <principle id="..."> tag you were shown.`;
  }
  requireToken();
  const response = await call("/api/ratings", { method: "POST", body: { hash: entry.hash, rating, ...(rater.agent && { agent: rater.agent }), ...(rater.model && { model: rater.model }) } });
  if (!response.ok) {
    throw await failure(response);
  }
  return `Recorded ${rating} for ${id}@${entry.version}. Thank you.`;
}
