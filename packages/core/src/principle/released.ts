import type { Manifest } from "./manifest.ts";

/**
 * A principle on a user's advisory board, at its newest release, as the
 * registry's board API lists it for a sync.
 */
export interface BoardPrinciple {
  /** `expert/slug`. */
  id: string;
  version: number;
  hash: string;
  enabled: boolean;
}

/** A released version of a principle, as the registry hands it out by its hash. */
export interface ReleasedBundle {
  id: string;
  version: number;
  hash: string;
  manifest: Manifest;
  advice: string;
  bundle: string;
}
