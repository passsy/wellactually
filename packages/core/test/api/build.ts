import fs from "node:fs";
import path from "node:path";
import { buildPrinciple, type Manifest } from "../../src/node.ts";

/** The principle each version's detector is built into. Only the detector matters. */
export const GOLDEN_ADVICE =
  "# Golden\n\nA detector that every later host has to keep running.\n\nIt reports one finding for each promise its detector API made about the event. A host that breaks one of them loses that finding, and the test that runs it fails.";

/**
 * Builds the detector of one detector API version, `v<n>/detector.ts`, as a
 * principle. It is built on every run from source: no compiled bundle is
 * checked in. What it pins is the event and the host functions of its
 * version, which `v<n>/shape.json` records.
 */
export async function buildVersion(version: number): Promise<{ manifest: Manifest; bundle: string }> {
  const source = fs.readFileSync(path.join(import.meta.dirname, `v${version}/detector.ts`), "utf8");
  const { manifest, bundle } = await buildPrinciple({ "principle.md": GOLDEN_ADVICE, "detector.ts": source });
  return { manifest, bundle };
}
