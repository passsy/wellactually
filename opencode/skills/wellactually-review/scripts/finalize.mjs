import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Assemble verified artifacts. No source reads, model calls or external mutations. */
export function finalizeReview(dir) {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  const plan = read("plan.json");
  const jobs = read("jobs.json");
  const route = read("route.json");
  const scope = read("scope.json");
  const units = [...new Set(jobs.map((job) => job.set ?? "all"))];
  if (units.length === 0) units.push("all");
  if (route.route === "sets") units.push("crossing");
  const sources = new Map();
  const verdicts = new Map();
  const nonFindingVerdicts = new Map();
  const dismissed = [];
  const rank = { not_applicable: 0, followed: 1, findings: 2 };
  const loadVerdicts = (stem) => {
    const value = read(`verdicts/${stem}.json`);
    for (const verdict of value.verdicts) {
      if (verdict.verdict !== "findings") {
        const previous = nonFindingVerdicts.get(verdict.principle);
        if (!previous || rank[verdict.verdict] > rank[previous]) nonFindingVerdicts.set(verdict.principle, verdict.verdict);
      }
      const previous = verdicts.get(verdict.principle);
      if (!previous || rank[verdict.verdict] > rank[previous.verdict]) verdicts.set(verdict.principle, { principle: verdict.principle, verdict: verdict.verdict });
      for (const [index, finding] of (verdict.findings ?? []).entries()) sources.set(`${stem}:${verdict.principle}:${index}`, { ...finding, principle: verdict.principle });
      for (const hit of verdict.dismissed ?? []) dismissed.push({ ...hit, principle: verdict.principle });
    }
    for (const [index, finding] of value.outside.entries()) sources.set(`${stem}:outside:${index}`, finding);
  };
  for (const job of jobs) loadVerdicts(job.id);
  if (route.route === "sets") loadVerdicts("crossing");
  for (const unit of units) loadVerdicts(`testing-${unit}`);
  const survivors = [];
  for (const unit of units) {
    for (const [index, entry] of read(`verified/${unit}.json`).entries()) {
      const ref = entry.promoted && !entry.candidate ? `verified/${unit}.json:${index}` : entry.candidate;
      if (!sources.has(ref) && !(entry.promoted && !entry.candidate)) throw new Error(`Unknown candidate ${ref}`);
      if (entry.status === "refuted") { dismissed.push({ candidate: ref, reason: entry.proof ?? entry.reason, status: "refuted" }); continue; }
      if (!["confirmed", "plausible"].includes(entry.status)) throw new Error(`Invalid status for ${ref}`);
      const finding = { ...sources.get(ref), ...entry, candidate: ref };
      if (finding.evidence === "proven" && !finding.provenTest) throw new Error(`Proven candidate ${ref} is missing provenTest`);
      survivors.push(finding);
    }
  }
  // Exact semantic text + anchor + scope only. Similar wording is not sufficient to merge.
  const merged = new Map();
  const evidenceRank = { speculative: 0, reasoned: 1, proven: 2 };
  for (const finding of survivors) {
    const key = JSON.stringify([finding.file, finding.line, finding.scope, finding.problem, finding.fix, finding.status]);
    const existing = merged.get(key);
    if (!existing) { merged.set(key, { ...finding, candidates: [finding.candidate], principles: finding.principle ? [finding.principle] : [] }); continue; }
    existing.candidates.push(finding.candidate);
    if (finding.principle && !existing.principles.includes(finding.principle)) existing.principles.push(finding.principle);
    if ((evidenceRank[finding.evidence] ?? -1) > (evidenceRank[existing.evidence] ?? -1)) Object.assign(existing, { evidence: finding.evidence, provenTest: finding.provenTest });
  }
  const all = [...merged.values()].sort((a, b) => String(a.priority ?? "p4").localeCompare(String(b.priority ?? "p4")) || (evidenceRank[b.evidence] ?? -1) - (evidenceRank[a.evidence] ?? -1));
  const standing = new Set(all.flatMap((finding) => finding.principles));
  for (const [id, verdict] of verdicts) {
    if (standing.has(id)) verdict.verdict = "findings";
    else if (verdict.verdict === "findings") verdict.verdict = nonFindingVerdicts.get(id) ?? "followed";
  }
  for (const id of standing) if (!verdicts.has(id)) verdicts.set(id, { principle: id, verdict: "findings" });
  const result = { complete: true, verdicts: [...verdicts.values()], findings: all.filter((finding) => finding.principles.length), outside: all.filter((finding) => !finding.principles.length), dismissed, outOfScope: scope.outOfScope };
  const ratings = [...standing].filter((id) => !id.startsWith("local/")).map((id) => ({ id, rating: "up" }));
  // Only explicit not-about-advice detector dismissals qualify for a negative applicability rating.
  for (const principle of plan.principles) {
    if (standing.has(principle.id) || principle.id.startsWith("local/") || !principle.detector || !(principle.hits?.length)) continue;
    const hits = dismissed.filter((hit) => hit.principle === principle.id && hit.notApplicable === true);
    if (hits.length >= principle.hits.length && verdicts.get(principle.id)?.verdict === "not_applicable") ratings.push({ id: principle.id, rating: "not_applicable" });
  }
  const lines = [`# Review of ${plan.target.label}`, ""];
  const render = (title, findings) => {
    lines.push(`## ${title}`, "");
    if (!findings.length) { lines.push("None found.", ""); return; }
    for (const finding of findings) lines.push(`- **${finding.priority ?? "p4"} · ${finding.scope} · ${finding.evidence ?? "reasoned"} · ${finding.status}** — ${finding.file}:${finding.line}: ${finding.problem} ${finding.fix}${finding.principles.length ? ` (${finding.principles.join(", ")})` : ""}${finding.status === "plausible" ? ` Dependency/limit: ${finding.reason ?? "See retained verification evidence."}` : ""}`, "");
  };
  render("Change-relevant findings", all.filter((finding) => finding.scope !== "pre_existing"));
  if (all.some((finding) => finding.scope === "pre_existing")) render("Pre-existing observations", all.filter((finding) => finding.scope === "pre_existing"));
  const counts = Object.fromEntries(Object.keys(rank).map((key) => [key, result.verdicts.filter((verdict) => verdict.verdict === key).length]));
  lines.push(`${result.verdicts.length} principles: ${counts.findings} with findings, ${counts.followed} followed, ${counts.not_applicable} not applicable; ${scope.outOfScope.length} out of scope.`, "", "## Checks and limits", "");
  for (const unit of units) {
    lines.push(`- Tests, commands, results and limitations: [${unit}](probes/${unit}/results.md). Verification assumptions and decisions: [${unit}](verified/${unit}.json).`);
    const results = fs.readFileSync(path.join(dir, `probes/${unit}/results.md`), "utf8");
    const limitations = results.split("\n").filter((line) => /blocked|unverified|limitation|unresolved|not (run|tested)|skipped/i.test(line));
    for (const line of limitations.slice(0, 8)) lines.push(`  ${line.trim()}`);
    if (fs.existsSync(path.join(dir, `challenges/${unit}.md`))) lines.push(`- Independent empty-set challenge: [${unit}](challenges/${unit}.md).`);
  }
  for (const [name, entries] of [["Out of scope", scope.outOfScope], ["Generated files omitted", plan.omitted ?? []], ["Principles skipped", plan.skipped ?? []], ["Detector failures", plan.failures ?? []], ["Unchecked files", plan.unchecked ?? []]]) {
    if (entries.length) lines.push(`- ${name}: ${JSON.stringify(entries)}`);
  }
  lines.push("", `Artifacts: ${dir}`, "");
  fs.writeFileSync(path.join(dir, "findings.json"), `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "ratings.json"), `${JSON.stringify(ratings, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "report.md"), lines.join("\n"));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const dir = path.resolve(process.argv[2] ?? ".");
    let root = path.dirname(fileURLToPath(import.meta.url));
    while (!fs.existsSync(path.join(root, "dist/wellactually.mjs"))) {
      const parent = path.dirname(root);
      if (parent === root) throw new Error("Cannot locate plugin dist/wellactually.mjs");
      root = parent;
    }
    const check = (stage) => execFileSync(process.execPath, [path.join(root, "dist/wellactually.mjs"), "review", "--check", dir, "--stage", stage], { stdio: "pipe" });
    check("verify");
    finalizeReview(dir);
    check("report");
    console.log(`Finalized ${dir}/report.md and findings.json; ratings.json is ready for MCP.`);
  } catch (error) { console.error(error.stderr?.toString() || error.message); process.exitCode = 1; }
}
