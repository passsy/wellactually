import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { zodSchema } from "../../../packages/findings/zod-schema.mts";
import { toolNamed } from "../../../packages/findings/tools.mts";
import { readCached, readLockfile } from "../../../packages/cli/src/board/board.ts";
import { createFindingRecord, getFindingRecord, updateFindingRecord, listFindingRecords, createOccurrence, getOccurrence, listOccurrences, updateOccurrence, claimReviewWork, completeReviewWork, getReviewSession, blockReviewWork } from "../../../packages/findings/index.mts";

const json = (file: string): any => JSON.parse(fs.readFileSync(file, "utf8"));
const contained = (root: string, file: string): boolean => file === root || file.startsWith(root + path.sep);

/** A capability boundary: no command strings, generic writes, registry mutations or other agents. */
export function reviewerAccess(dir: string, jobId: string) {
  dir = fs.realpathSync(dir);
  const plan = json(path.join(dir, "plan.json"));
  const job = json(path.join(dir, "jobs.json")).find((each: any) => each.id === jobId);
  if (!job) throw new Error("Unknown reviewer job");
  const tracking = json(path.join(dir, "tracking.json"));
  const root = fs.realpathSync(plan.root);
  const readable = new Set(["task.md", "context.md", "plan.json", "tracking.json", "jobs.json", "principles.md", ...(fs.existsSync(path.join(dir, "sets.json")) ? ["sets.json"] : []), `agents/reviewer-${jobId}/INSTRUCTIONS.md`, ...job.parts]);
  const artifacts = proofReferences(dir, root);
  const queueArgs = { repo: root, target: tracking.target, session: tracking.session, queue: job.queue, worker: jobId };
  const current = () => getReviewSession(queueArgs, root).queues.find(q => q.id === job.queue)?.items.find(item => !item.completed && !item.blocked && item.claim?.worker === jobId && Date.parse(item.claim.until) > Date.now());
  const sourcePath = (input: string): string => {
    const file = fs.realpathSync(path.resolve(root, input));
    if (!contained(root, file) || contained(dir, file) || path.relative(root, file).split(path.sep).some(part => [".git", ".well-actually", ".pascal-review", "node_modules"].includes(part))) throw new Error("Source path is outside the review's readable source");
    return file;
  };
  return {
    read(input: string, start = 1, count = 200): string {
      const proposed = path.resolve(dir, input);
      const canonical = fs.existsSync(proposed) ? fs.realpathSync(proposed) : proposed;
      const relative = path.relative(dir, canonical);
      const file = readable.has(relative) ? canonical : sourcePath(input);
      if (readable.has(relative) && !contained(dir, file)) throw new Error("Artifact symlink escapes review directory");
      if (fs.statSync(file).size > 2_000_000) throw new Error("File is too large");
      return fs.readFileSync(file, "utf8").split("\n").slice(start - 1, start - 1 + count).map((line, i) => `${start + i}: ${line}`).join("\n");
    },
    search(query: string, input = "."): string {
      try {
        return execFileSync("rg", ["--fixed-strings", "--line-number", "--max-count", "50", "--glob", "!.well-actually/**", "--glob", "!.pascal-review/**", "--", query, sourcePath(input)], { cwd: root, encoding: "utf8", maxBuffer: 1_000_000 }).slice(0, 40000);
      } catch (error: any) { if (error.status === 1) return "No matches"; throw error; }
    },
    before(input: string): string {
      if (plan.before) {
        const before = fs.realpathSync(plan.before);
        const file = fs.realpathSync(path.resolve(before, input));
        if (!contained(before, file)) throw new Error("Previous-source path is outside the before root");
        if (fs.statSync(file).size > 2_000_000) throw new Error("Previous source is too large");
        return fs.readFileSync(file, "utf8");
      }
      const resolved = path.resolve(root, input);
      if (!contained(root, resolved)) throw new Error("Previous-source path is outside the source root");
      const relative = path.relative(root, resolved);
      if (!plan.target.base) throw new Error("No Git comparison base");
      return execFileSync("git", ["--no-pager", "show", `${plan.target.base}:${relative}`], { cwd: root, encoding: "utf8", maxBuffer: 2_000_000 });
    },
    principle(id: string): unknown {
      if (job.queue ? current()?.principle?.id !== id : !job.principles.includes(id)) throw new Error("Principle is not claimed by this reviewer");
      const pinned = plan.principles.find((each: any) => each.id === id);
      const entry = readLockfile().entries.find(each => each.id === id && each.version === pinned.version);
      const cached = entry && readCached(entry.hash);
      if (!cached) throw new Error("Pinned principle is unavailable; do not sync during review");
      return { id, version: entry.version, body: cached.advice };
    },
    recordTool(name: string, input: Record<string, unknown>): unknown {
      const active = job.queue ? current() : undefined;
      if (job.queue && !active) throw new Error("Claim work before editing findings");
      const address = {repo:root,target:tracking.target};
      const own = (id: string) => {
        const finding = getFindingRecord({...address,id},root);
        if (!finding.origins.some(o=>o.run===tracking.run && o.unit===(job.queue??job.set??"all") && (!active || o.source.startsWith(`${job.queue}/${active.id}/`)))) throw new Error("Finding is outside the claimed review item");
        return finding;
      };
      const rulesAllowed = (data: any) => {
        if ((data.verdict !== undefined && data.verdict !== "undecided") || data.reportedAt !== undefined || (data.assessments??[]).some((a:any)=>a.authorType === "human")) throw new Error("Reviewers cannot set human disposition or reporting");
        if ((data.rules??[]).some((r:any)=>job.queue ? r.id !== active?.principle?.id : !job.principles.includes(r.id))) throw new Error("Finding refers to an unassigned principle");
        if ((data.evidence??[]).some((e:any)=>e.kind === "test")) throw new Error("Reviewers cannot claim executable proof");
      };
      if (name === "create_finding") {
        const data = input.finding as any; rulesAllowed(data);
        const source = `${job.queue??jobId}/${active?.id??"static"}/${String(input.idempotencyKey??"")}`;
        if (!input.idempotencyKey) throw new Error("Supply a stable idempotencyKey within this review item");
        return createFindingRecord({...address,prefix:input.prefix,idempotencyKey:`${tracking.run}/${source}`,finding:{...artifacts.record(data),origins:[{run:tracking.run,unit:job.queue??job.set??"all",source,...(active?.principle?{rule:active.principle.id}:{})}]}},root);
      }
      if (name === "get_finding" || name === "update_finding") {
        own(String(input.id));
        if (name === "get_finding") return getFindingRecord({...address,id:input.id},root);
        const patch = input.patch as any; rulesAllowed(patch);
        if (["state","closure","verdict","reportedAt","note","origins","metadata","assessments","links"].some(k=>k in patch)) throw new Error("Reviewer may edit the claim, rules and source evidence only");
        return updateFindingRecord({...input,...address,patch:artifacts.record(patch)},root);
      }
      if (name === "create_occurrence") { const data=input.occurrence as any; own(String(data.findingId)); rulesAllowed(data); return createOccurrence({...input,...address,occurrence:artifacts.record(data)},root); }
      if (name === "list_occurrences") { own(String(input.findingId)); return listOccurrences({...input,...address},root); }
      const occurrence=getOccurrence({...address,id:input.id},root); own(occurrence.findingId);
      if (name === "get_occurrence") return occurrence;
      const patch=input.patch as any;
      if (Object.keys(patch).some(k=>!["description","locations","evidence"].includes(k))) throw new Error("Reviewer may edit occurrence description, locations and source evidence only");
      rulesAllowed(patch); return updateOccurrence({...input,...address,patch:artifacts.record(patch)},root);
    },
    claim(): unknown { if (!job.queue) throw new Error("This is a legacy static assignment"); return claimReviewWork(queueArgs, root); },
    complete(item: string, claim: string, result: Record<string, unknown>): unknown { if (!job.queue) throw new Error("This is a legacy static assignment"); return completeReviewWork({ ...queueArgs, item, claim, result }, root); },
    verdict(value: Record<string, unknown>): string {
      if (job.queue) throw new Error("Queue workers submit coverage with complete_review_work; no verdict files");
      if (value.job !== jobId) throw new Error("Coverage belongs to another job");
      const output = path.join(dir, "verdicts");
      fs.mkdirSync(output, { recursive: true });
      if (!contained(dir, fs.realpathSync(output))) throw new Error("Verdict directory escapes review directory");
      const file = path.join(output, `${jobId}.json`);
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error("Verdict is a symlink");
      fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
      return "Coverage saved";
    },
  };
}

export async function serveReviewer(dir: string, job: string): Promise<void> {
  const access = reviewerAccess(dir, job);
  const server = new McpServer({ name: "wellactually-reviewer", version: "1.0.0" });
  const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });
  server.registerTool("read_text", { inputSchema: { path: z.string(), start: z.number().int().min(1).optional(), count: z.number().int().min(1).max(1000).optional() } }, async args => reply(access.read(args.path, args.start, args.count)));
  server.registerTool("search_source", { inputSchema: { query: z.string(), path: z.string().optional() } }, async args => reply(access.search(args.query, args.path)));
  server.registerTool("read_before", { inputSchema: { path: z.string() } }, async args => reply(access.before(args.path)));
  server.registerTool("get_principle", { inputSchema: { id: z.string() } }, async args => reply(access.principle(args.id)));
  const data = z.record(z.string(),z.unknown());
  for (const [name,inputSchema] of [
    ["create_finding",{finding:data,prefix:z.string().regex(/^[A-Za-z]$/).optional(),idempotencyKey:z.string()}],
    ["get_finding",{id:z.string()}],
    ["update_finding",{id:z.string(),expectedRevision:z.number().int(),patch:data}],
    ["create_occurrence",{occurrence:data,prefix:z.string().regex(/^[A-Za-z]$/).optional(),idempotencyKey:z.string().optional()}],
    ["get_occurrence",{id:z.string()}],
    ["list_occurrences",{findingId:z.string()}],
    ["update_occurrence",{id:z.string(),expectedRevision:z.number().int(),patch:data}],
  ] as const) server.registerTool(name,{inputSchema},async (input: Record<string,unknown>)=>reply(access.recordTool(name,input)));
  server.registerTool("claim_review_work", { inputSchema: {} }, async () => reply(access.claim()));
  server.registerTool("complete_review_work", { inputSchema: { item: z.string(), claim: z.string(), result: z.record(z.string(), z.unknown()) } }, async args => reply(access.complete(args.item, args.claim, args.result)));
  server.registerTool("write_verdict", { inputSchema: { value: z.record(z.string(), z.unknown()) } }, async args => reply(access.verdict(args.value)));
  await server.connect(new StdioServerTransport());
}

/** Resolve worker-relative references before they cross into the repository-owned store. */
export function proofReferences(dir: string, source: string) {
  const reference = (value: string): string => {
    if (/^https?:\/\//.test(value)) return value;
    const match = /^(.*?)(:\d+(?:-\d+)?)?$/.exec(value)!;
    const file = match[1]!, suffix = match[2] ?? "";
    const candidates = path.isAbsolute(file) ? [file] : [path.resolve(dir, file), path.resolve(source, file)];
    const found = candidates.find(candidate => fs.statSync(candidate, {throwIfNoEntry:false})?.isFile());
    if (!found) throw new Error(`Proof file does not exist: ${value}. Use an existing test/probe or Markdown proof, relative to the review directory or an absolute path.`);
    return found + suffix;
  };
  const record = (value: any): any => ({
    ...value,
    ...(Array.isArray(value.evidence) ? {evidence:value.evidence.map((e:any) => ({
      ...e, artifacts:(e.artifacts ?? []).map((artifact:string) => {
        if (e.kind === "test" && /\.(?:txt|log|diff|patch)(?::\d+(?:-\d+)?)?$/i.test(artifact)) throw new Error("Attach a runnable test/probe or a self-contained Markdown proof, not raw logs or patches.");
        return reference(artifact);
      }),
    }))} : {}),
  });
  return {reference, record};
}

/** Proof workers can execute via host tools, but their MCP surface cannot triage humans or change queues. */
export async function serveVerification(dir: string, worker: string): Promise<void> {
  const plan = json(path.join(dir, "plan.json")), tracking = json(path.join(dir, "tracking.json"));
  const args = { repo: plan.root, target: tracking.target, session: tracking.session, queue: "verification", worker };
  const proofs = proofReferences(dir, plan.root);
  const server = new McpServer({ name: "wellactually-proof-worker", version: "1.0.0" });
  const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  const active = () => getReviewSession(args, plan.root).queues.find(q => q.id === "verification")?.items.find(i => !i.completed && !i.blocked && i.claim?.worker === worker && Date.parse(i.claim.until) > Date.now());
  server.registerTool("claim_review_work", { inputSchema: {} }, async () => reply(claimReviewWork(args, plan.root)));
  const assigned = (id: string) => { const item=active(); if(!item?.findings?.includes(id)) throw new Error("Finding is outside the claimed issue"); return getFindingRecord({...args,id},plan.root); };
  const schema = (name:string,field:string) => zodSchema((toolNamed(name)!.inputSchema as any).properties[field]) as z.ZodType<Record<string,unknown>>;
  const findingPatch=schema("update_finding","patch"), occurrenceData=schema("create_occurrence","occurrence"), occurrencePatch=schema("update_occurrence","patch");
  server.registerTool("list_findings",{inputSchema:{}},async()=>{const item=active();if(!item)throw new Error("Claim an issue first");return reply(listFindingRecords({...args,run:tracking.run},plan.root).filter(f=>item.findings!.includes(f.id)));});
  server.registerTool("get_finding",{inputSchema:{id:z.string()}},async({id})=>reply(assigned(id)));
  server.registerTool("update_finding",{inputSchema:{id:z.string(),expectedRevision:z.number().int(),patch:findingPatch}},async input=>{assigned(input.id);if(["verdict","reportedAt","origins","metadata","note"].some(k=>k in input.patch)||(input.patch.assessments as any[]??[]).some(a=>a.authorType==="human"))throw new Error("Proof workers cannot change provenance or human notes/assessments");return reply(updateFindingRecord({...input,...args,patch:proofs.record(input.patch)},plan.root));});
  server.registerTool("list_occurrences",{inputSchema:{findingId:z.string()}},async input=>{assigned(input.findingId);return reply(listOccurrences({...input,...args},plan.root));});
  server.registerTool("create_occurrence",{inputSchema:{occurrence:occurrenceData,prefix:z.string().regex(/^[A-Za-z]$/).optional(),idempotencyKey:z.string().optional()}},async input=>{assigned(String(input.occurrence.findingId));return reply(createOccurrence({...input,...args,occurrence:proofs.record(input.occurrence)},plan.root));});
  server.registerTool("update_occurrence",{inputSchema:{id:z.string(),expectedRevision:z.number().int(),patch:occurrencePatch}},async input=>{const occurrence=getOccurrence({...args,id:input.id},plan.root);assigned(occurrence.findingId);if(input.patch.findingId)assigned(String(input.patch.findingId));if((input.patch.assessments as any[]??[]).some(a=>a.authorType==="human"))throw new Error("Proof workers cannot create human assessments");return reply(updateOccurrence({...input,...args,patch:proofs.record(input.patch)},plan.root));});
  server.registerTool("get_principle", { inputSchema: { id: z.string() } }, async ({ id }) => {
    const item = active();
    if (!item || !listFindingRecords({ ...args, run: tracking.run }, plan.root).some(f => item.findings!.includes(f.id) && f.rules.some(r=>r.id===id))) throw new Error("Principle is not attached to the claimed issue");
    const pinned = plan.principles.find((p: any) => p.id === id), entry = readLockfile().entries.find(p => p.id === id && p.version === pinned?.version), cached = entry && readCached(entry.hash);
    if (!cached) throw new Error("Pinned advice unavailable"); return reply({ id, version: entry.version, body: cached.advice });
  });
  server.registerTool("complete_review_work",{description:"Complete investigation after saving evidence and assessments with CRUD. Reference every assigned finding and its saved assessment IDs. Proof paths must name existing files; review-relative artifact paths are saved as absolute paths. This does not change finding state.",inputSchema:{item:z.string(),claim:z.string(),result:z.object({summary:z.string(),proofs:z.array(z.string()),limits:z.array(z.string()),decisions:z.array(z.object({id:z.string(),revision:z.number().int().min(1),assessmentIds:z.array(z.string()).min(1),evidenceIds:z.array(z.string()).optional()})).min(1)})}},async input=>reply(completeReviewWork({...args,...input,result:{...input.result,proofs:input.result.proofs.map(proofs.reference)}},plan.root)));
  await server.connect(new StdioServerTransport());
}

export type WorkerProvider = "codex" | "claude";

/** Claude has no equivalent of Codex's workspace-write sandbox; do not silently broaden it. */
export function claudeWorkerArgs(script: string, dir: string, job: string, model: string, effort: string, prompt: string, verification: boolean, proofSandbox: string): string[] {
  if (verification) throw new Error("Claude proof workers must use the native Agent tool to inherit parent permissions; the separate CLI proof launcher is disabled");
  const mcp = { mcpServers: { review: { command: process.execPath, args: [script, verification ? "--verification-server" : "--reviewer-server", path.resolve(dir), "--job", job] } } };
  return ["-p", "--model", model, "--effort", effort, "--strict-mcp-config", "--mcp-config", JSON.stringify(mcp), "--tools", verification ? "Bash,Read,Grep,Glob" : "", "--allowedTools", verification ? "Bash,Read,Grep,Glob,mcp__review" : "mcp__review", "--setting-sources", "", "--settings", JSON.stringify({ disableAllHooks: true }), "--disable-slash-commands", "--no-session-persistence", "--output-format", "stream-json", "--verbose", prompt];
}

/** Normalize outcomes without persisting another advice or findings store. */
export function claudeEvents(event: any, calls: Map<string, any>): any[] {
  const events: any[] = [];
  for (const block of event.message?.content ?? []) {
    if (block.type === "tool_use") calls.set(block.id, block);
    if (block.type === "tool_result") {
      const call = calls.get(block.tool_use_id);
      if (!call) continue;
      events.push({ type: "item.completed", item: { type: "mcp_tool_call", tool: call.name.replace(/^mcp__review__/, ""), server: "review", arguments: call.input, status: block.is_error ? "failed" : "completed", result: { isError: Boolean(block.is_error), content: typeof block.content === "string" ? [{ type: "text", text: block.content }] : block.content } } });
      calls.delete(block.tool_use_id);
    }
  }
  if (event.type === "result") events.push(event.is_error ? { type: "turn.failed", error: (event.errors ?? [event.result ?? event.subtype]).join("\n") } : { type: "turn.completed", usage: event.usage, duration_ms: event.duration_ms, total_cost_usd: event.total_cost_usd });
  if (event.type === "error") events.push({ type: "error", error: event.error ?? event.message });
  return events;
}

/** Fresh restricted reviewer or host-policy proof worker, sharing one queue/audit contract. */
export async function runReviewer(dir: string, job: string, script: string, model: string, effort: string, verification = false, proofSandbox = "workspace-write", signal?: AbortSignal, provider: WorkerProvider = "codex"): Promise<number> {
  if (!["workspace-write", "danger-full-access"].includes(proofSandbox)) throw new Error("Unsupported proof sandbox");
  if (!verification) reviewerAccess(dir, job); // Fail before dispatch when the assignment is invalid.
  const folder = verification ? job : `reviewer-${job}`;
  if (verification && !/^verification-worker-[1-9][0-9]*$/.test(job)) throw new Error("Invalid verification worker id");
  if (!fs.existsSync(path.join(dir, "agents", folder, "INSTRUCTIONS.md"))) throw new Error("Missing worker instructions");
  const workspace = verification && fs.existsSync(path.join(dir, "agents", folder, "workspace.json")) ? json(path.join(dir, "agents", folder, "workspace.json")).root : dir;
  const args = ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--sandbox", verification ? proofSandbox : "read-only", ...(verification ? ["--add-dir", path.resolve(dir)] : []), ...(!verification ? ["--disable", "shell_tool", "--disable", "unified_exec"] : []), "--disable", "plugins", "--disable", "multi_agent", "--disable", "multi_agent_v2", "-c", "agents.enabled=false", "-c", "agents.max_depth=0", "-c", 'web_search="disabled"', "-m", model, "--json", "-c", `model_reasoning_effort=${JSON.stringify(effort)}`, "-c", `mcp_servers.review={default_tools_approval_mode="approve",required=true,command=${JSON.stringify(process.execPath)},args=${JSON.stringify([script, verification ? "--verification-server" : "--reviewer-server", path.resolve(dir), "--job", job])}}`, `Read ${path.join(path.resolve(dir), "agents", folder, "INSTRUCTIONS.md")} ${verification ? "using shell/read tools" : "using review.read_text"} and execute that reviewer assignment. All paths in instructions may be absolute. ${verification ? "Execution tools are available for focused proofs; keep tracked product files unchanged. The MCP gateway limits candidates/advice to your currently claimed issue." : "Use only review MCP tools. No execution tool is provided."} Save findings immediately using create_finding, then record their occurrences with create_occurrence. Queue jobs repeatedly claim_review_work and complete_review_work until waiting or complete. Legacy jobs use write_verdict. Queue tools take no repo/session/queue/worker arguments; the gateway supplies them. The gateway supplies repo, target, run and unit; do not supply them. Source paths are relative to the source root; artifact paths relative to the review directory. Do not attempt execution through other tools.`];
  return new Promise((resolve, reject) => {
    const commandArgs = provider === "claude" ? claudeWorkerArgs(script, dir, job, model, effort, args.at(-1)!, verification, proofSandbox) : args;
    const child = spawn(provider, commandArgs, { cwd: path.resolve(workspace), env: { ...process.env, WELLACTUALLY_REVIEW_HOST: provider }, stdio: ["ignore", "pipe", "pipe"], signal });
    const audit = fs.createWriteStream(path.join(dir, `agents/${folder}/tool-audit.jsonl`));
    // Kept beside the audit so the pool can tell a host that cannot start the CLI from a crashed worker.
    const errors = fs.createWriteStream(path.join(dir, `agents/${folder}/cli-stderr.log`));
    child.stderr.on("data", chunk => { process.stderr.write(chunk); errors.write(chunk); });
    let pending = "";
    let coverageSaved = false;
    const calls = new Map<string, any>();
    child.stdout.on("data", chunk => {
      pending += String(chunk);
      const lines = pending.split("\n"); pending = lines.pop() ?? "";
      for (const line of lines) {
        try {
          for (const event of provider === "claude" ? claudeEvents(JSON.parse(line), calls) : [JSON.parse(line)]) {
          const item = event.item;
          let failure = item?.error;
          if (!failure && (item?.status === "failed" || item?.result?.isError)) failure = item.result?.content?.filter((entry: any) => entry.type === "text").map((entry: any) => entry.text).join("\n").slice(0, 1200) || "Tool failed without an error body";
          if (event.type === "item.completed" && item.status === "completed" && !item.error && !item.result?.isError) {
            if (item?.tool === "write_verdict") coverageSaved = true;
            if (item?.tool === "claim_review_work") {
              const content = item.result?.content?.find((entry: any) => entry.type === "text")?.text;
              try { coverageSaved = ["complete", "waiting", "blocked"].includes(JSON.parse(content).state); } catch { /* No usable response cannot certify completion. */ }
            }
          }
          // Audit capabilities and outcomes without creating another advice/findings store.
          const record = { at: new Date().toISOString(), type: event.type, ...(event.thread_id ? { thread: event.thread_id } : {}), ...(["error", "turn.failed"].includes(event.type) ? { error: String(event.message ?? event.error?.message ?? event.error ?? "Unspecified CLI failure").slice(0, 2000) } : {}), ...(item ? { tool: item.tool, server: item.server, kind: item.type, status: item.status, error: failure, ...(item.tool === "read_text" ? { path: item.arguments?.path } : {}), ...(item.arguments?.item ? { item: item.arguments.item } : {}), ...(item.type === "agent_message" ? { text: item.text } : {}) } : {}), ...(event.usage ? { usage: event.usage } : {}), ...(event.duration_ms !== undefined ? { duration_ms: event.duration_ms } : {}), ...(event.total_cost_usd !== undefined ? { total_cost_usd: event.total_cost_usd } : {}) };
          const serialized = JSON.stringify(record) + "\n";
          audit.write(serialized); process.stdout.write(serialized);
          }
        } catch { process.stderr.write(line + "\n"); }
      }
    });
    child.on("error", reject);
    child.on("close", code => { if (!coverageSaved) process.stderr.write("Reviewer did not save its assigned coverage; review is incomplete.\n"); errors.end(); audit.end(() => resolve(code === 0 && coverageSaved ? 0 : code || 1)); });
  });
}

/**
 * The worker CLI died before its first event because the host's sandbox kept
 * it from writing its own state, as Codex's workspace sandbox does to a nested
 * `codex exec`. Every replacement would die the same way.
 */
export function sandboxedHost(events: unknown[], stderr: string): boolean {
  return events.length === 0 && /Operation not permitted|attempt to write a readonly database/i.test(stderr);
}

export const SANDBOXED_HOST = "The worker CLI could not start inside the host sandbox, so retrying cannot help. Run this command again outside the sandbox: in Codex, ask for escalation (sandbox_permissions: require_escalated). Never replace the restricted worker with an unrestricted one.";

export function failureKind(events: { type?: string; error?: unknown }[]): "blocked" | "transient" {
  const errors = events.filter(e => e.error).map(e => typeof e.error === "string" ? e.error : JSON.stringify(e.error)).join("\n");
  return /possible cybersecurity risk|content was flagged|safeguard|safety.{0,30}(reject|block)|policy.{0,30}(reject|violation)|permission.{0,80}denied|auto mode classifier|create unsafe agents|tool use was rejected|user doesn't want to proceed/i.test(errors) ? "blocked" : "transient";
}

/** Restart ordinary dead workers in fresh contexts; never replay a safeguard-rejected item. */
export async function runWorkerPool(dir: string, script: string, model: string, effort: string, verification = false, proofSandbox = "workspace-write", provider: WorkerProvider = "codex"): Promise<number> {
  if (verification && provider === "claude") throw new Error("Claude proof workers must use the native Agent tool to inherit parent permissions; the separate CLI proof launcher is disabled");
  dir = path.resolve(dir);
  const tracking = json(path.join(dir, "tracking.json")), plan = json(path.join(dir, "plan.json"));
  const sessionArgs = { repo: plan.root, target: tracking.target, session: tracking.session };
  const jobs = verification ? Array.from({ length: getReviewSession(sessionArgs, plan.root).queues.find(q => q.phase === "verification")!.workers }, (_, i) => ({ id: `verification-worker-${i + 1}`, queue: "verification" })) : json(path.join(dir, "jobs.json"));
  const abort = new AbortController(), stop = () => abort.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const results = await Promise.all(jobs.map(async (job: { id: string; queue: string }) => {
      const audit = path.join(dir, "agents", verification ? job.id : `reviewer-${job.id}`, "tool-audit.jsonl");
      if (fs.existsSync(audit)) {
        const prior = fs.readFileSync(audit, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
        if (failureKind(prior) === "blocked") {
          const reason = prior.filter(e => e.error).map(e => e.error).filter(Boolean).join("\n");
          try { blockReviewWork({ ...sessionArgs, queue: job.queue, worker: job.id, reason }, plan.root); } catch { /* Already blocked or rejected before any claim. */ }
          process.stderr.write(`Prior safeguard rejection for ${job.id}; automatic replay is disabled.\n`); return 1;
        }
      }
      for (let attempt = 1; attempt <= 3 && !abort.signal.aborted; attempt++) {
        if (fs.existsSync(audit)) fs.renameSync(audit, `${audit}.before-${Date.now()}-${attempt}`);
        process.stdout.write(JSON.stringify({ event: "worker_start", worker: job.id, attempt, at: new Date().toISOString() }) + "\n");
        let code: number;
        try { code = await runReviewer(dir, job.id, script, model, effort, verification, proofSandbox, abort.signal, provider); }
        catch (error) { if (abort.signal.aborted) return 1; process.stderr.write(String(error) + "\n"); code = 1; }
        process.stdout.write(JSON.stringify({ event: "worker_exit", worker: job.id, attempt, code, at: new Date().toISOString() }) + "\n");
        if (abort.signal.aborted) return code || 1;
        const events = fs.existsSync(audit) ? fs.readFileSync(audit, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
        const stderr = path.join(path.dirname(audit), "cli-stderr.log");
        if (code !== 0 && sandboxedHost(events, fs.existsSync(stderr) ? fs.readFileSync(stderr, "utf8") : "")) {
          process.stderr.write(`${job.id}: ${SANDBOXED_HOST}\n`);
          return 1;
        }
        if (failureKind(events) === "blocked") {
          const reason = events.filter(e => e.error).map(e => e.error).filter(Boolean).join("\n");
          try { blockReviewWork({ ...sessionArgs, queue: job.queue, worker: job.id, reason: reason || "Explicit CLI safeguard rejection" }, plan.root); } catch { /* Rejection can precede the first claim; never retry that request either. */ }
          process.stderr.write(`Automatic safety review rejected ${job.id}: ${reason}. No replacement will replay this request.\n`);
          return 1;
        }
        if (code === 0) return 0;
      }
      return 1;
    }));
    return results.every(code => code === 0) ? 0 : 1;
  } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
