import type { Manifest } from "./manifest.ts";

/** One principle on a board, pinned to the exact version the user accepted. */
export interface BoardEntry {
  /** `advisor/slug`, or `local/slug` for a principle added from a directory. */
  id: string;
  version: number;
  hash: string;
  enabled: boolean;
}

/** The lockfile: what the hook runs. Written by `wellactually sync` and `wellactually add`, read on every hook call. */
export interface Lockfile {
  syncedAt: string | null;
  entries: BoardEntry[];
}

/** A principle as stored in the local cache, keyed by hash. */
export interface CachedPrinciple {
  id: string;
  version: number;
  hash: string;
  manifest: Manifest;
  advice: string;
  bundle: string;
}
