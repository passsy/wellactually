import path from "node:path";
import { fileURLToPath } from "node:url";
import { runReviewer, runWorkerPool, serveReviewer, serveVerification } from "./reviewer-runtime.ts";
import { parseArgs } from "node:util";
import { readLockfile, readConfig } from "../../../packages/cli/src/board/board.ts";
import { sync } from "../../../packages/cli/src/registry/client.ts";
import { setupVerificationAgents, buildSets, checkReview, loadPrinciples, parseBudget, planReview, planInputReview, renderPlan, renderRoute, renderSets, routeReview, setupAgents } from "./review.ts";

async function main(): Promise<number> {
  const { values } = parseArgs({ options: {
    json: { type: "boolean", default: false }, help: { type: "boolean", short: "h" },
    root: { type: "string" }, files: { type: "string", multiple: true }, patch: { type: "string" },
    "before-root": { type: "string" }, label: { type: "string" }, git: { type: "string" },
    out: { type: "string" }, check: { type: "string" }, stage: { type: "string" },
    route: { type: "string" }, sets: { type: "string" }, budget: { type: "string" },
    "load-principles": { type: "string" },
    "setup-agents": { type: "string" },
    "setup-verifiers": { type: "string" },
    "run-verifier": { type: "string" }, "verification-server": { type: "string" },
    "proof-sandbox": { type: "string" }, provider: { type: "string", default: "codex" },
    "run-reviewers": { type: "string" }, "run-verifiers": { type: "string" },
    "reviewer-server": { type: "string" }, "run-reviewer": { type: "string" }, job: { type: "string" }, model: { type: "string" }, effort: { type: "string" },
  } });
  if (values.provider !== "codex" && values.provider !== "claude") throw new Error("--provider must be codex or claude");
  if (values.help) {
    console.log(`Review preparation helpers (Git is optional):
  node review.mjs --root <folder> --files <file-or-folder> [--files ...]
  node review.mjs --root <folder> --patch <unified.patch> [--before-root <folder>]
  node review.mjs --root <repository> --git local|<range-or-ref>
  node review.mjs --load-principles <review-directory>
  node review.mjs --setup-agents <review-directory>
  node review.mjs --route <review-directory> [--budget <tokens>]
  node review.mjs --sets <review-directory>
  node review.mjs --check <review-directory> --stage review|verify
  node review.mjs --run-reviewers <dir> --provider codex|claude --model <model> --effort <effort>
  node review.mjs --run-verifiers <dir> --provider codex|claude --model <model> --effort <effort> --proof-sandbox <host-policy>
Optional: --out <directory>, --label <scope-description>, --json.
No --git/--patch means a snapshot of selected current files, not a change against an invented baseline.`);
    return 0;
  }
  const print = (data: unknown, rendered: string): void => console.log(values.json ? JSON.stringify(data, null, 2) : rendered);
  if (values["run-reviewers"] || values["run-verifiers"]) {
    const verification = Boolean(values["run-verifiers"]), dir = values["run-verifiers"] ?? values["run-reviewers"]!;
    if (!values.model || !values.effort || (verification && !values["proof-sandbox"])) throw new Error("Worker pools require --model, --effort and proof pools need --proof-sandbox matching host policy");
    const code = await runWorkerPool(dir, fileURLToPath(import.meta.url), values.model, values.effort, verification, values["proof-sandbox"], values.provider);
    if (code !== 0) return code;
    checkReview(dir, verification ? "verify" : "review"); return 0;
  }
  if (values["reviewer-server"]) { await serveReviewer(values["reviewer-server"], values.job ?? "all"); return 0; }
  if (values["verification-server"]) { await serveVerification(values["verification-server"], values.job ?? "verification-worker-1"); return 0; }
  if (values["run-verifier"]) { if (!values.model || !values.effort || !values["proof-sandbox"]) throw new Error("--run-verifier requires --model, --effort and --proof-sandbox matching the coordinator's host policy (workspace-write or danger-full-access)"); return runReviewer(values["run-verifier"], values.job ?? "verification-worker-1", fileURLToPath(import.meta.url), values.model, values.effort, true, values["proof-sandbox"], undefined, values.provider); }
  if (values["run-reviewer"]) { if (!values.model || !values.effort) throw new Error("--run-reviewer requires the coordinator's --model and --effort"); return runReviewer(values["run-reviewer"], values.job ?? "all", fileURLToPath(import.meta.url), values.model, values.effort, false, "workspace-write", undefined, values.provider); }
  if (values.check) {
    const result = checkReview(values.check, values.stage ?? "verify");
    print(result, `Review ${result.stage} is complete: ${result.jobs} jobs, ${result.units} units, ${result.candidates} candidates.`); return 0;
  }
  if (values.route) { const result = routeReview(values.route, values.budget ? parseBudget(values.budget) : undefined); print(result, renderRoute(result)); return 0; }
  if (values.sets) { const result = buildSets(values.sets); print(result, renderSets(result)); return 0; }
  if (values["setup-agents"]) { const files = setupAgents(values["setup-agents"]); print(files, files.join("\n")); return 0; }
  if (values["setup-verifiers"]) { const files = setupVerificationAgents(values["setup-verifiers"]); print(files, files.join("\n")); return 0; }
  if (values.git && (values.patch || values.files?.length)) throw new Error("Choose --git, --patch, or --files; do not combine scopes");
  if (values["before-root"] && !values.patch) throw new Error("--before-root needs --patch");
  if (values["load-principles"] && readLockfile().syncedAt === null && readConfig().token !== null) {
    const synced = await sync(); console.error(`Downloaded the advisory board first: ${synced.entries.length} principles.`);
  }
  if (values["load-principles"]) { const plan = await loadPrinciples(values["load-principles"]); print(plan, renderPlan(plan)); return 0; }
  const root = path.resolve(values.root ?? process.cwd());
  const plan = values.git
    ? await planReview(root, values.git, values.out, null, values.label)
    : await planInputReview(root, { paths: values.files, patch: values.patch, beforeRoot: values["before-root"], label: values.label }, values.out, null);
  print(plan, renderPlan(plan)); return 0;
}
main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
});
