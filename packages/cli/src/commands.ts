import fs from "node:fs";
import path from "node:path";
import { apiOf, applies, approvalKey, buildPrinciple, BundleError, describeReview, checkPrinciple, isPrincipleId, PRINCIPLE_ID_RULE, fileCtx, isPackageFile, ManifestError, parseTags, needsApproval, readPrinciple, readPrincipleDir, runDetector, textCtx, type BuiltPrinciple, type CheckReport, type DetectorRun, type FileMap, type PackageInfo } from "@wellactually/core/node";
import type { Ctx } from "@wellactually/sdk";
import { diskFiles, projectRootOf, toPosix, writeFileMap } from "./board/files.ts";
import { frame, DEFAULT_REGISTRY, readConfig, readLockfile, writeCached, writeLockfile } from "./board/board.ts";
import { probeRepo, type ProbeReport } from "./probe.ts";
import { type SwitchResult } from "./board/switches.ts";
import {
  fetchHistory,
  publishDraft,
  pullSource,
  RegistryError,
  releaseDraft,
  setVisibility,
  syncRepository,
  type DraftResult,
  type History,
  type ReleaseResult,
  type RepositorySync,
  type SyncResult,
  type Visibility,
  type VisibilityResult,
} from "./registry/client.ts";

/**
 * The verbs behind both the command line and the MCP server.
 *
 * Each returns data. Rendering it for a terminal or for an agent is the
 * caller's job, which is what keeps the two front ends saying the same thing.
 */

export interface TestResult {
  id: string | null;
  title: string | null;
  report: CheckReport;
}

/** A principle's id is the name of its folder. */
function idOf(dir: string): string {
  return path.basename(path.resolve(dir));
}

/** The check a principle directory has to pass, including that its folder name can be an id. */
async function checkDir(dir: string) {
  const { built, report } = await checkPrinciple(await readPrinciple(path.resolve(dir)));
  const id = idOf(dir);
  if (isPrincipleId(id)) {
    return { id, built, report };
  }
  const problem = `the folder name "${id}" is the principle's id and must be ${PRINCIPLE_ID_RULE}; rename the folder`;
  return { id, built, report: { ...report, ok: false, problems: [problem, ...report.problems] } };
}

export async function testPrinciple(dir: string): Promise<TestResult> {
  const { id, built, report } = await checkDir(dir);
  return { id, title: built?.manifest.title ?? null, report };
}

export interface TryInput {
  /** A file to show the detector as if the agent had just written it. */
  file?: string;
  /** Treat `file` as read rather than written. */
  read?: boolean;
  prompt?: string;
  command?: string;
  /** What `command` printed. With it the event is the output, not the command about to run. */
  output?: string;
}

export interface TryResult {
  /** False when no handler of the detector wants this input, so it never ran. */
  applies: boolean;
  run: DetectorRun | null;
  /** What the agent would be shown, empty when nothing fired. */
  injected: string;
}

export async function tryPrinciple(dir: string, input: TryInput): Promise<TryResult> {
  const built = await buildPrinciple(await readPrinciple(path.resolve(dir)));
  const ctx = tryCtx(input);
  if (!applies(built.manifest, ctx)) {
    return { applies: false, run: null, injected: "" };
  }
  const run = await runDetector(built.bundle, ctx, undefined, diskFiles(), apiOf(built.manifest));
  const injected = frame(ctx, run.findings.length > 0 ? [{ principle: asLocal(built, idOf(dir)), findings: run.findings }] : []);
  return { applies: true, run, injected };
}

function tryCtx(input: TryInput): Ctx {
  const here = projectRootOf(process.cwd());
  if (input.prompt !== undefined) {
    return textCtx("prompt", input.prompt, here === null ? null : toPosix(here), "", toPosix(process.cwd()));
  }
  if (input.output !== undefined) {
    return textCtx("output", input.output, here === null ? null : toPosix(here), input.command ?? "", toPosix(process.cwd()));
  }
  if (input.command !== undefined) {
    return textCtx("command", input.command, here === null ? null : toPosix(here), "", toPosix(process.cwd()));
  }
  if (input.file === undefined) {
    throw new Error("pass a file, --prompt, --command or --output");
  }
  // Like the hook: the project root is the repository the file is in, when it is in one.
  const absolute = path.resolve(input.file);
  const root = projectRootOf(path.dirname(absolute));
  const relative = path.relative(root ?? process.cwd(), absolute);
  const shown = relative.startsWith("..") ? path.basename(absolute) : toPosix(relative);
  return fileCtx(input.read ? "read" : "write", shown, fs.readFileSync(absolute, "utf8"), undefined, { root: root === null ? null : toPosix(root), absolute: toPosix(absolute) });
}

export async function probePrinciple(dir: string, repo: string): Promise<ProbeReport> {
  const built = await buildPrinciple(await readPrinciple(path.resolve(dir)));
  return probeRepo(built, path.resolve(repo));
}

/** Thrown when a principle has packages the expert has to approve, and nobody was there to ask. */
export class ApprovalError extends Error {}

export interface PublishOptions {
  /** The packages the expert approved beforehand, each as `name@version`. */
  approved?: string[];
  /**
   * Asks the expert about one package. Without it nobody can be asked, and a
   * package that was not approved beforehand stops the publish.
   */
  confirm?: (info: PackageInfo) => Promise<boolean>;
  /** Who can see it after the upload. Left out, it stays as it is, and a new principle is private. */
  visibility?: Visibility;
}

/** One line about a package whose licence the expert has to approve. */
export function describeApproval(info: PackageInfo): string {
  return `${approvalKey(info)}: ${describeReview(info)}`;
}

/**
 * The packages in the bundle the expert has to approve before the principle
 * is uploaded. Empty when it does not build: then the registry says why.
 */
async function packagesToApprove(files: FileMap): Promise<PackageInfo[]> {
  try {
    return ((await buildPrinciple(files)).manifest.packages ?? []).filter(needsApproval);
  } catch (error) {
    if (error instanceof ManifestError || error instanceof BundleError) {
      return [];
    }
    throw error;
  }
}

/**
 * Uploads a principle, which the registry releases when it passes.
 *
 * A package whose licence does not pass by itself goes into the bundle only
 * when the expert approved it: named in `approved`, or answered with yes when
 * asked. The registry checks the same and takes no draft without it.
 */
export async function publishPrinciple(dir: string, options: PublishOptions = {}): Promise<DraftResult> {
  const id = idOf(dir);
  if (!isPrincipleId(id)) {
    throw new Error(`The folder name "${id}" is the principle's id and must be ${PRINCIPLE_ID_RULE}. Rename the folder, then publish again.`);
  }
  const files = await readPrinciple(path.resolve(dir));
  const approved: string[] = [];
  const open: PackageInfo[] = [];
  for (const info of await packagesToApprove(files)) {
    const key = approvalKey(info);
    if (options.approved?.includes(key)) {
      approved.push(key);
      continue;
    }
    if (options.confirm !== undefined && (await options.confirm(info))) {
      approved.push(key);
      continue;
    }
    open.push(info);
  }
  if (open.length > 0) {
    const lines = ["Not uploaded. The detector contains packages whose licence you have to approve:"];
    for (const info of open) {
      lines.push(`  - ${describeApproval(info)}`);
    }
    lines.push("Approve them by name, each at exactly this version:");
    lines.push(`  wellactually publish ${dir} ${open.map((info) => `--approve ${approvalKey(info)}`).join(" ")}`);
    throw new ApprovalError(lines.join("\n"));
  }
  return publishDraft(id, files, approved, options.visibility);
}

/** What an accepted upload ended in: released, or a draft and why. */
export function renderPublished(result: DraftResult): string {
  const lines = [
    result.released
      ? `Released revision ${result.version} of ${result.id}: ${result.url}`
      : result.held
        ? `Draft revision ${result.version} uploaded, not released: ${result.held}\n${result.url}`
        : `Draft revision ${result.version} uploaded. Release it at ${result.url}`,
  ];
  if (result.visibilityRefused) {
    lines.push(`Its visibility did not change: ${result.visibilityRefused}`);
  }
  if (result.visibility) {
    lines.push(describeVisibility(result.visibility, result.publicOnRelease ?? false));
  }
  return lines.join("\n");
}

/** Who can see a principle, in a sentence. */
function describeVisibility(visibility: Visibility, publicOnRelease: boolean): string {
  if (visibility === "public") {
    return "It is public: anyone can read it and put it on their advisory board.";
  }
  return publicOnRelease ? "It is private until its first release, which makes it public." : "It is private: only you, and private collections you share it with, see it.";
}

/** Sets who can see one of the user's own principles. */
export async function changeVisibility(id: string, visibility: string): Promise<VisibilityResult> {
  if (visibility !== "public" && visibility !== "private") {
    throw new Error(`Visibility is public or private, not "${visibility}".`);
  }
  return setVisibility(id, visibility);
}

export function renderVisibility(result: VisibilityResult): string {
  return `${result.id}: ${describeVisibility(result.visibility, result.publicOnRelease)}\n${result.url}`;
}

/** Releases the waiting draft of one of the user's own principles. */
export async function releasePrinciple(id: string): Promise<ReleaseResult> {
  return releaseDraft(id);
}

export function renderRelease(result: ReleaseResult): string {
  return `Released revision ${result.version} of ${result.id}: ${result.url}`;
}

/** Has the registry read a repository that is connected on the website, without waiting for a push. */
export async function syncRepo(name: string): Promise<RepositorySync> {
  return syncRepository(name);
}

export function renderRepositorySync(result: RepositorySync): string {
  const lines = [`${result.repository} at ${result.commit.slice(0, 7)}`];
  for (const item of result.principles) {
    let version = "";
    if (item.version !== null) {
      version = ` r${item.version}`;
    }
    lines.push(`  ${item.status.padEnd(9)} ${result.handle}/${item.slug}${version}  ${item.path}`);
    for (const problem of item.problems) {
      lines.push(`            ${problem}`);
    }
  }
  if (result.principles.length === 0) {
    lines.push("  No folder with a principle.md was found.");
  }
  return lines.join("\n");
}

export async function principleHistory(id: string): Promise<History> {
  return fetchHistory(id);
}

const CHANGE_MARKS = { added: "A", modified: "M", removed: "D" } as const;

/** A principle's history in the shape of `git log --name-status`. */
export function renderHistory(result: History): string {
  const lines: string[] = [];
  for (const entry of result.history) {
    const label = entry.status === "draft" ? " (draft, not released)" : "";
    lines.push(`revision ${entry.version}${label}  ${entry.hash.slice(0, 12)}`);
    lines.push(`Date:   ${entry.date.slice(0, 16).replace("T", " ")}`);
    lines.push("");
    if (entry.changed.length === 0) {
      lines.push(entry.version === 1 ? "    First revision" : "    Package code only");
    } else {
      for (const file of entry.changed) {
        lines.push(`${CHANGE_MARKS[file.change]}       ${file.path}`);
      }
    }
    lines.push("");
  }
  lines.push(`${result.id} is ${result.visibility}. Get a revision with: wellactually pull ${result.id}@<revision>`);
  return lines.join("\n");
}

export interface PullResult {
  id: string;
  version: number;
  status: "draft" | "released";
  dir: string;
  files: string[];
  /** Who it is by: the expert of the original first, then each who forked it. */
  credits: string[];
}

/**
 * Brings a principle from the registry into a directory, ready for `wellactually test` and `wellactually publish`.
 *
 * This is the other half of editing in the browser: whatever was saved there
 * is what arrives here. An existing directory is only replaced with `force`,
 * because replacing it discards local edits.
 */
export async function pullPrinciple(id: string, dir: string | undefined, force: boolean): Promise<PullResult> {
  const source = await pullSource(id);
  const target = path.resolve(dir ?? source.id.split("/")[1] ?? "principle");
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    if (!force) {
      throw new Error(`${target} already has files. Pass --force to replace them with the registry's version.`);
    }
    for (const name of Object.keys(readPrincipleDir(target))) {
      fs.rmSync(path.join(target, name));
    }
  }
  // The code of packages is not written out. `npm install` puts the same versions there, complete.
  const own: FileMap = {};
  for (const [name, content] of Object.entries(source.files)) {
    if (!isPackageFile(name)) {
      own[name] = content;
    }
  }
  writeFileMap(target, own);
  return { id: source.id, version: source.version, status: source.status, dir: target, files: Object.keys(own).sort(), credits: source.credits ?? [] };
}

/**
 * Who a principle is by, in one line: "Original by @passsy, edited by @john
 * and @jimmy". `handles` starts with the expert of the original and goes on
 * with each who forked it on the way, oldest first. Null when only one
 * expert worked on it.
 */
export function describeCredits(handles: string[]): string | null {
  const [original, ...editors] = handles;
  if (original === undefined || editors.length === 0) {
    return null;
  }
  const named = editors.map((handle) => `@${handle}`);
  const last = named.pop() as string;
  return `Original by @${original}, edited by ${named.length > 0 ? `${named.join(", ")} and ${last}` : last}`;
}

export function renderPull(result: PullResult): string {
  const what = result.status === "draft" ? `the draft of revision ${result.version}` : `revision ${result.version}`;
  let install = "";
  if (result.files.includes("package.json")) {
    install = `\nIt uses packages. Install them first: npm install --prefix ${result.dir}`;
  }
  const described = describeCredits(result.credits);
  const credits = described === null ? "" : `\n${described}.`;
  return `Pulled ${what} of ${result.id} into ${result.dir} (${result.files.length} files).${credits}${install}\nEdit it, then run its tests and publish it.`;
}

/** Hosts whose principle links name a principle of the registry, besides the one this machine is signed in to. */
const REGISTRY_HOSTS = [new URL(DEFAULT_REGISTRY).host, "www.wellactually.dev"];

/**
 * Turns what an agent has in hand into the id the registry knows: `expert/principle`
 * with an optional `@revision`, a bare principle id, or a link to its page such as
 * https://wellactually.dev/p/passsy/avoid-late?v=3. A bare id is returned as it is.
 */
export function principleIdOf(reference: string): string {
  const trimmed = reference.trim();
  const link = /^(https?:\/\/)?([^/\s]+)(\/p\/[^\s]*)$/i.exec(trimmed);
  if (!link) {
    return trimmed.replace(/^@/, "");
  }
  const url = new URL(`${link[1] ?? "https://"}${link[2]}${link[3]}`);
  const hosts = [...REGISTRY_HOSTS, new URL(readConfig().registry).host];
  if (!hosts.includes(url.host)) {
    throw new RegistryError(`${reference} is not a link to a principle on ${hosts[0]}.`);
  }
  const [handle, slug] = url.pathname.split("/").slice(2).map(decodeURIComponent);
  if (!handle || !slug) {
    throw new RegistryError(`${reference} does not name a principle. A principle's link looks like https://${hosts[0]}/p/expert/principle.`);
  }
  const version = url.searchParams.get("v");
  return `${handle}/${slug}${version ? `@${version}` : ""}`;
}

export interface ShownPrinciple {
  id: string;
  version: number;
  status: "draft" | "released";
  /** Who it is by: the expert of the original first, then each who forked it. */
  credits: string[];
  visibility: Visibility | null;
  tags: string[];
  link: string;
  /** The whole of principle.md. */
  advice: string;
}

/**
 * Fetches a principle's advice to read, by id, bare name or link.
 *
 * A bare name is one of the user's own first, then one on their advisory board.
 * The registry answers only what the user may see, so a private principle of
 * someone else reads as not found.
 */
export async function showPrinciple(reference: string): Promise<ShownPrinciple> {
  const id = principleIdOf(reference);
  const [name = ""] = id.split("@");
  const source = name.includes("/") ? await pullSource(id) : await pullByName(id);
  let tags: string[] = [];
  try {
    tags = parseTags(source.files["package.json"]);
  } catch {
    // A broken package.json is the author's to fix. The advice still reads.
  }
  const [handle = "", slug = ""] = source.id.split("/");
  const link = new URL(`/p/${encodeURIComponent(handle)}/${encodeURIComponent(slug)}`, readConfig().registry).href;
  return {
    id: source.id,
    version: source.version,
    status: source.status,
    credits: source.credits ?? [handle],
    visibility: source.visibility ?? null,
    tags,
    link,
    advice: (source.files["principle.md"] ?? "").trim(),
  };
}

/** A bare principle id: the user's own when they have one by that name, else the one on their advisory board. */
async function pullByName(id: string) {
  const [slug = "", version] = id.split("@");
  const suffix = version === undefined ? "" : `@${version}`;
  const own = readConfig().handle;
  if (own) {
    try {
      return await pullSource(`${own}/${id}`);
    } catch (error) {
      if (!(error instanceof RegistryError && error.status === 404)) {
        throw error;
      }
    }
  }
  const onBoard = readLockfile()
    .entries.map((entry) => entry.id)
    .filter((entryId) => entryId.split("/")[1] === slug && !entryId.startsWith("local/") && entryId !== `${own}/${slug}`);
  const unique = [...new Set(onBoard)];
  if (unique.length > 1) {
    throw new RegistryError(`Several principles are named ${slug}: ${unique.join(", ")}. Pass the one you mean as expert/principle.`);
  }
  if (unique[0] === undefined) {
    const whose = own ? `You have no principle named ${slug}, and none on your advisory board is.` : `No principle on your advisory board is named ${slug}.`;
    throw new RegistryError(`${whose} Pass it as expert/principle, or as its link.`);
  }
  return pullSource(`${unique[0]}${suffix}`);
}

export function renderShow(result: ShownPrinciple): string {
  const revision = result.status === "draft" ? `draft of revision ${result.version}, not released` : `revision ${result.version}`;
  const [original = "", ...editors] = result.credits;
  const lines = [`${result.id} (${revision})`, `Author: @${original}${editors.length > 0 ? `, edited by ${editors.map((handle) => `@${handle}`).join(", ")}` : ""}`];
  if (result.visibility) {
    lines.push(`Visibility: ${result.visibility}`);
  }
  lines.push(`Tags: ${result.tags.length > 0 ? result.tags.join(", ") : "none"}`, `Link: ${result.link}`, "", result.advice);
  return lines.join("\n");
}

function asLocal(built: BuiltPrinciple, id: string) {
  return { ...built, id: `local/${id}`, version: 0 };
}

/**
 * Puts a principle from a directory on this machine's advisory board, without a registry.
 *
 * It has to pass the same check a published one does. The advisory board pins the
 * hash, so editing the directory changes nothing until it is added again.
 */
export async function addLocal(dir: string): Promise<TestResult> {
  const { id, built, report } = await checkDir(dir);
  if (!built || !report.ok) {
    return { id, title: built?.manifest.title ?? null, report };
  }
  const principle = asLocal(built, id);
  writeCached(principle);
  const lockfile = readLockfile();
  const entries = lockfile.entries.filter((entry) => entry.id !== principle.id);
  entries.push({ id: principle.id, version: 0, hash: principle.hash, enabled: true });
  writeLockfile({ ...lockfile, entries });
  return { id: principle.id, title: built.manifest.title, report };
}

/** Takes a local principle off the advisory board. Registry entries are removed on the website. */
export function removeLocal(id: string): boolean {
  const lockfile = readLockfile();
  const wanted = id.startsWith("local/") ? id : `local/${id}`;
  const entries = lockfile.entries.filter((entry) => entry.id !== wanted);
  if (entries.length === lockfile.entries.length) {
    return false;
  }
  writeLockfile({ ...lockfile, entries });
  return true;
}

export function renderReport(result: TestResult): string {
  const lines: string[] = [];
  if (result.id) {
    lines.push(`${result.id}  ${result.title ?? ""}`.trimEnd());
  }
  let file = "";
  for (const item of result.report.tests) {
    if (item.file !== file) {
      file = item.file;
      lines.push(`  ${file}`);
    }
    lines.push(`    ${item.passed ? "✓" : "✗"} ${item.name}`);
    if (!item.passed) {
      lines.push(...item.message.split("\n").map((line) => `        ${line}`));
    }
  }
  if (result.report.tests.length > 0) {
    lines.push(`  Slowest detector run ${result.report.slowestMs.toFixed(1)} ms.`);
  }
  for (const warning of result.report.warnings) {
    lines.push(`  ! ${warning}`);
  }
  // Reports from a registry that does not know about licences yet have no such list.
  for (const info of result.report.unapproved ?? []) {
    lines.push(`  ! Needs your approval to be published: ${describeApproval(info)}`);
  }
  if (result.report.ok) {
    lines.push("Ready to publish.");
  } else {
    lines.push("Not ready:");
    for (const problem of result.report.problems) {
      lines.push(`  - ${problem}`);
    }
  }
  return lines.join("\n");
}

/** What to tell whoever switched a principle off or on. */
export function renderSwitch(result: SwitchResult, on: boolean): string {
  const where = result.scope === "global" ? "everywhere on this machine" : "in this project";
  if (!on) {
    return `${result.id} is off ${where}. Recorded in ${result.file}.`;
  }
  if (result.stillOff.length > 0) {
    const other = result.stillOff.includes("global") ? "everywhere on this machine" : "in this project";
    return `${result.id} is no longer switched off ${where}, but it is still off ${other}. Switch it on there too to make it run.`;
  }
  return `${result.id} runs again ${where}.`;
}

export function renderProbe(report: ProbeReport): string {
  const lines = [
    `Scanned ${report.scanned} files, ${report.matched} are ones the detector handles, ${report.fired} fired (${report.findings} findings). Slowest run ${report.slowestMs.toFixed(1)} ms.`,
    report.verdict,
  ];
  for (const sample of report.samples) {
    lines.push(`  ${sample.path}  ${sample.text}`);
  }
  for (const failure of report.errors.slice(0, 10)) {
    lines.push(`  ✗ ${failure.path}  ${failure.error}`);
  }
  return lines.join("\n");
}

export function renderTry(result: TryResult): string {
  if (!result.applies || !result.run) {
    return "No handler in detector.ts wants this input, so the detector does not run.";
  }
  const { run } = result;
  if (run.error) {
    return `The detector failed: ${run.error}`;
  }
  const lines = [`${run.findings.length} findings in ${run.ms.toFixed(1)} ms.`];
  for (const dropped of run.dropped) {
    lines.push(`Left out: ${dropped}`);
  }
  if (result.injected) {
    lines.push("", "The agent would be shown:", "", result.injected);
  }
  return lines.join("\n");
}

/** What `wellactually sync` prints, with experts to follow when the advisory board is empty. */
export function renderSync(result: SyncResult): string {
  const enabled = result.entries.filter((entry) => entry.enabled).length;
  const summary = `${result.entries.length} principles on your advisory board, ${enabled} enabled. Downloaded ${result.downloaded.length}, removed ${result.removed.length}.${result.reported > 0 ? ` Reported ${result.reported} detections.` : ""}`;
  if (result.suggestions.length === 0) {
    return summary;
  }
  const experts = result.suggestions.map((expert) => {
    const name = expert.name && expert.name !== expert.handle ? `${expert.name} (@${expert.handle})` : `@${expert.handle}`;
    const tips = expert.tips.length > 0 ? `: ${expert.tips.join("; ")}` : "";
    return `  ${name}, ${expert.principles} ${expert.principles === 1 ? "principle" : "principles"}${tips}\n    ${expert.url}`;
  });
  return [summary, "", "Your advisory board is empty. Experts you can follow:", ...experts, "", "Follow the ones you like on their page, then sync again."].join("\n");
}
