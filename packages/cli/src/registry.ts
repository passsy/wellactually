import {
  drainDetections,
  hashPrinciple,
  hasCached,
  readConfig,
  readLockfile,
  writeCached,
  writeConfig,
  writeLockfile,
  type BoardEntry,
  type CachedPrinciple,
  type CheckReport,
  type FileMap,
} from "@wellactually/core/node";

export class RegistryError extends Error {}

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

async function failure(response: Response): Promise<RegistryError> {
  if (response.status === 401) {
    return new RegistryError("not signed in, or the token was revoked. Run `wellactually login`.");
  }
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return new RegistryError(body?.error ?? `the registry answered ${response.status}`);
}

function requireToken(): void {
  if (!readConfig().token) {
    throw new RegistryError("not signed in. Run `wellactually login`.");
  }
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
    const response = await call("/api/device/poll", { method: "POST", body: { device_code: start.device_code }, token: null });
    if (response.status === 202) {
      continue;
    }
    if (!response.ok) {
      throw await failure(response);
    }
    const { token, handle } = (await response.json()) as { token: string; handle: string };
    writeConfig({ ...readConfig(), token, handle });
    return handle;
  }
  throw new RegistryError("the code expired before it was confirmed. Run `wellactually login` again.");
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
  /** Where the human reviews and releases the draft. */
  url: string | null;
  report: CheckReport;
}

/** Uploads a principle as a private draft of `slug`. The registry rebuilds it and reruns every case. */
export async function publishDraft(slug: string, files: FileMap, note = ""): Promise<DraftResult> {
  requireToken();
  const response = await call("/api/drafts", { method: "POST", body: { slug, files, note } });
  if (response.status !== 201 && response.status !== 422) {
    throw await failure(response);
  }
  const body = (await response.json()) as Omit<DraftResult, "accepted">;
  return { ...body, accepted: response.status === 201 };
}

export interface SyncResult {
  entries: BoardEntry[];
  downloaded: string[];
  removed: string[];
  /** Detections reported to the registry with this sync. */
  reported: number;
}

/**
 * Brings the local board in line with the one on the registry.
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
  const remote = ((await response.json()) as { entries: BoardEntry[] }).entries;

  const downloaded: string[] = [];
  for (const entry of remote) {
    if (hasCached(entry.hash)) {
      continue;
    }
    const bundleResponse = await call(`/api/bundles/${entry.hash}`);
    if (!bundleResponse.ok) {
      throw await failure(bundleResponse);
    }
    const principle = (await bundleResponse.json()) as CachedPrinciple;
    const actual = await hashPrinciple(principle.manifest, principle.advice, principle.bundle);
    if (actual !== entry.hash) {
      throw new RegistryError(`${entry.id} does not match its hash. Refusing to install it.`);
    }
    writeCached({ ...principle, id: entry.id, version: entry.version, hash: entry.hash });
    downloaded.push(entry.id);
  }

  const before = readLockfile();
  const local = before.entries.filter((entry) => entry.id.startsWith("local/"));
  const remoteIds = new Set(remote.map((entry) => entry.id));
  const removed = before.entries
    .filter((entry) => !entry.id.startsWith("local/") && !remoteIds.has(entry.id))
    .map((entry) => entry.id);
  writeLockfile({ syncedAt: new Date().toISOString(), entries: [...remote, ...local] });
  return { entries: remote, downloaded, removed, reported: await reportDetections() };
}

/**
 * Sends how often each principle fired since the last sync: a day, a hash and a count.
 *
 * It is a courtesy to the authors, so it never fails a sync. What could not
 * be sent stays on disk and goes out next time.
 */
async function reportDetections(): Promise<number> {
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
  files: FileMap;
}

/** Splits `advisor/principle@3` into its parts. A bare principle id means one of the user's own. */
function parseId(id: string): { handle: string; slug: string; version: number | null } {
  const [name = "", versionText] = id.split("@");
  const full = name.includes("/") ? name : `${readConfig().handle ?? ""}/${name}`;
  const [handle, slug, ...rest] = full.split("/");
  const version = versionText === undefined ? null : Number(versionText.replace(/^v/, ""));
  if (!handle || !slug || rest.length > 0 || (version !== null && (!Number.isInteger(version) || version < 1))) {
    throw new RegistryError(`"${id}" is not a principle id. Use advisor/principle, optionally with @version, or just the principle for one of your own.`);
  }
  return { handle, slug, version };
}

/** Downloads a principle's files: a given version, else your own draft when one is waiting, else the newest release. */
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
  note: string;
  changed: { path: string; change: "added" | "modified" | "removed" }[];
}

export interface History {
  id: string;
  visibility: "private" | "public";
  history: HistoryEntry[];
}

/** A principle's versions, newest first. */
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
 * Sends an agent's verdict on a principle on this machine's board.
 *
 * The verdict is about the version the agent was shown, so the id is resolved
 * through the local board, not through the registry's newest release.
 * Returns what to tell the agent.
 */
export async function ratePrinciple(id: string, rating: Rating): Promise<string> {
  if (id.startsWith("local/")) {
    return `${id} is a local principle. It belongs to no registry, so there is nobody to send a rating to.`;
  }
  if (!readConfig().stats) {
    return "Reporting is turned off on this machine (`wellactually stats off`), so the rating was not sent.";
  }
  const entry = readLockfile().entries.find((candidate) => candidate.id === id);
  if (!entry) {
    return `${id} is not on this board. Use the id from the <principle id="..."> tag you were shown.`;
  }
  requireToken();
  const response = await call("/api/ratings", { method: "POST", body: { hash: entry.hash, rating } });
  if (!response.ok) {
    throw await failure(response);
  }
  return `Recorded ${rating} for ${id}@${entry.version}. Thank you.`;
}
