import path from "node:path";
import { parseArgs } from "node:util";
import { readLockfile, readConfig } from "../../../packages/cli/src/board/board.ts";
import { sync } from "../../../packages/cli/src/registry/client.ts";
import { buildSets, checkReview, parseBudget, planReview, planInputReview, renderPlan, renderRoute, renderSets, routeReview } from "./review.ts";

async function main(): Promise<number> {
  const { values } = parseArgs({ options: {
    json: { type: "boolean", default: false }, help: { type: "boolean", short: "h" },
    root: { type: "string" }, files: { type: "string", multiple: true }, patch: { type: "string" },
    "before-root": { type: "string" }, label: { type: "string" }, git: { type: "string" },
    out: { type: "string" }, check: { type: "string" }, stage: { type: "string" },
    route: { type: "string" }, sets: { type: "string" }, budget: { type: "string" },
  } });
  if (values.help) {
    console.log(`Review preparation helpers (Git is optional):
  node review.mjs --root <folder> --files <file-or-folder> [--files ...]
  node review.mjs --root <folder> --patch <unified.patch> [--before-root <folder>]
  node review.mjs --root <repository> --git local|<range-or-ref>
  node review.mjs --route <review-directory> [--budget <tokens>]
  node review.mjs --sets <review-directory>
  node review.mjs --check <review-directory> --stage review|test|verify|report
Optional: --out <directory>, --label <scope-description>, --json.
No --git/--patch means a snapshot of selected current files, not a change against an invented baseline.`);
    return 0;
  }
  const print = (data: unknown, rendered: string): void => console.log(values.json ? JSON.stringify(data, null, 2) : rendered);
  if (values.check) {
    const result = checkReview(values.check, values.stage ?? "report");
    print(result, `Review ${result.stage} is complete: ${result.jobs} jobs, ${result.units} units, ${result.candidates} candidates.`); return 0;
  }
  if (values.route) { const result = routeReview(values.route, values.budget ? parseBudget(values.budget) : undefined); print(result, renderRoute(result)); return 0; }
  if (values.sets) { const result = buildSets(values.sets); print(result, renderSets(result)); return 0; }
  if (values.git && (values.patch || values.files?.length)) throw new Error("Choose --git, --patch, or --files; do not combine scopes");
  if (values["before-root"] && !values.patch) throw new Error("--before-root needs --patch");
  if (readLockfile().syncedAt === null && readConfig().token !== null) {
    const synced = await sync(); console.error(`Downloaded the advisory board first: ${synced.entries.length} principles.`);
  }
  const root = path.resolve(values.root ?? process.cwd());
  const plan = values.git
    ? await planReview(root, values.git, values.out, readLockfile(), values.label)
    : await planInputReview(root, { paths: values.files, patch: values.patch, beforeRoot: values["before-root"], label: values.label }, values.out);
  print(plan, renderPlan(plan)); return 0;
}
main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
});
