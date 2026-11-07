import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { reviewerAccess, runWorkerPool, claudeWorkerArgs } from "../../../skills/review/scripts/reviewer-runtime.ts";
import { claimReviewSession, getReviewSession } from "../../findings/queues.mts";

describe("reviewer capability boundary", () => {
  test.each(["codex", "claude"] as const)("%s pool recovers crashes and never replays safeguard blocks", async (provider) => {
   for (const blocked of [false, true]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-pool-test-")), source = path.join(dir, "project"), bin = path.join(dir, "bin");
    fs.mkdirSync(source); fs.mkdirSync(bin);
    const session = claimReviewSession({ repo: source, target: "test", run: "r", sets: [{ id: "all", principles: [] }] }, source);
    fs.writeFileSync(path.join(dir, "tracking.json"), JSON.stringify({ repo: source, target: "test", session: session.id }));
    fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ root: source }));
    fs.writeFileSync(path.join(dir, "jobs.json"), JSON.stringify([{ id: "one", queue: "all", set: null, parts: [], principles: [] }]));
    fs.mkdirSync(path.join(dir, "agents/reviewer-one"), { recursive: true });
    fs.writeFileSync(path.join(dir, "agents/reviewer-one/INSTRUCTIONS.md"), "Test worker");
    const module = fileURLToPath(new URL("../../findings/queues.mts", import.meta.url));
    const stub = `#!${process.execPath}\nimport fs from 'node:fs';import {claimReviewWork,completeReviewWork} from ${JSON.stringify(module)};let args=JSON.parse(fs.readFileSync('tracking.json'));args={...args,queue:'all',worker:'one'};const attempt=fs.existsSync('attempt')?Number(fs.readFileSync('attempt','utf8'))+1:1;fs.writeFileSync('attempt',String(attempt));let next=claimReviewWork(args,args.repo);if(attempt===1){console.log(JSON.stringify({type:'error',message:${JSON.stringify(blocked ? "This content was flagged for possible cybersecurity risk" : "Temporary provider connection lost")}}));process.exit(1);}while(next.state==='claimed'){completeReviewWork({...args,item:next.work.id,claim:next.work.claim.token,result:{findings:[],investigation:{status:'complete',reason:'Source traced',questions:[{question:'Contract?',answer:'Satisfied',evidence:['file:1']}],limits:[]}}},args.repo);next=claimReviewWork(args,args.repo);}console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',tool:'claim_review_work',status:'completed',result:{content:[{type:'text',text:JSON.stringify(next)}]}}}));\n`;
    const claudeTail = `console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'claim',name:'mcp__review__claim_review_work',input:{}}]}}));console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'claim',content:JSON.stringify(next)}]}}));console.log(JSON.stringify({type:'result',is_error:false,usage:{output_tokens:10}}));`;
    const executable = provider === "claude" ? stub.slice(0, stub.indexOf("console.log(JSON.stringify({type:'item.completed'")) + claudeTail : stub;
    fs.writeFileSync(path.join(bin, provider), executable, { mode: 0o755 });
    const previous = process.env.PATH; process.env.PATH = bin + path.delimiter + previous;
    try {
      expect(await runWorkerPool(dir, "/unused-script", "test", "medium", false, "workspace-write", provider)).toBe(blocked ? 1 : 0);
      expect(Number(fs.readFileSync(path.join(dir, "attempt"), "utf8"))).toBe(blocked ? 1 : 2);
      const item = getReviewSession({ ...JSON.parse(fs.readFileSync(path.join(dir, "tracking.json"), "utf8")) }, source).queues[0]!.items[0]!;
      expect(Boolean(item.blocked)).toBe(blocked); expect(Boolean(item.completed)).toBe(!blocked);
      if (blocked) { expect(await runWorkerPool(dir, "/unused-script", "test", "medium", false, "workspace-write", provider)).toBe(1); expect(Number(fs.readFileSync(path.join(dir, "attempt"), "utf8"))).toBe(1); }
    } finally { process.env.PATH = previous; }
   }
  }, 20000);
  test("Claude exposes no built-in reviewer tools and refuses a broader proof policy", () => {
    const args = claudeWorkerArgs("script", "/review", "one", "opus", "medium", "prompt", false, "workspace-write");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--settings") + 1]).toContain('"disableAllHooks":true');
    expect(() => claudeWorkerArgs("script", "/review", "one", "opus", "medium", "prompt", true, "workspace-write")).toThrow("full-access");
    expect(claudeWorkerArgs("script", "/review", "one", "opus", "medium", "prompt", true, "danger-full-access")).toContain("Bash,Read,Grep,Glob");
  });
  test("permits source inspection and assigned coverage but rejects other locations and principles", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-boundary-"));
    const source = path.join(root, "source");
    const review = path.join(root, "review");
    fs.mkdirSync(source); fs.mkdirSync(review);
    fs.writeFileSync(path.join(source, "code.rs"), "hello\nworld\n");
    fs.mkdirSync(path.join(source, ".well-actually"));
    fs.writeFileSync(path.join(source, ".well-actually", "secret"), "hidden");
    fs.writeFileSync(path.join(review, "plan.json"), JSON.stringify({ root: source, target: {}, principles: [] }));
    fs.writeFileSync(path.join(review, "jobs.json"), JSON.stringify([{ id: "all", principles: [], parts: [] }]));
    fs.writeFileSync(path.join(review, "tracking.json"), JSON.stringify({ target: "local", run: "r" }));
    fs.writeFileSync(path.join(review, "sets.json"), JSON.stringify({ sets: [] }));
    const access = reviewerAccess(review, "all");
    expect(access.read("code.rs", 2, 1)).toBe("2: world");
    expect(access.read("sets.json")).toContain('"sets"');
    const alias = path.join(root, "review-alias"); fs.symlinkSync(review, alias);
    expect(access.read(path.join(alias, "sets.json"))).toContain('"sets"');
    fs.writeFileSync(path.join(root, "unassigned.txt"), "private");
    expect(() => access.read("../unassigned.txt")).toThrow();
    expect(() => access.read(".well-actually/secret")).toThrow();
    expect(() => access.before("../../outside")).toThrow();
    expect(() => access.principle("skipped/rule")).toThrow("not claimed");
    expect(() => access.candidates([{ rule: "skipped/rule" }])).toThrow("unassigned");
    expect(() => access.verdict({ job: "other" })).toThrow();
    fs.symlinkSync(path.join(source, "code.rs"), path.join(source, "escape"));
    expect(access.read("escape")).toContain("hello");
    fs.symlinkSync(path.join(review, "plan.json"), path.join(source, "outside"));
    expect(() => access.read("outside")).toThrow();
    expect(access.verdict({ job: "all", verdicts: [], outside: [] })).toBe("Coverage saved");
    expect(fs.existsSync(path.join(review, "verdicts/all.json"))).toBe(true);
  });
});
