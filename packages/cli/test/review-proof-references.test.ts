import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { reviewerAccess, proofReferences } from "../../../skills/review/scripts/reviewer-runtime.ts";
import { createFindingRecord } from "../../findings/crud.mts";
import { readSource } from "../../findings/api.mts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root,{recursive:true,force:true})));
function fixture() {
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"wa-proof-path-")));roots.push(base);
  const source=path.join(base,"checkout"),dir=path.join(base,"review");
  fs.mkdirSync(source);fs.mkdirSync(path.join(dir,"probes"),{recursive:true});
  return {source,dir,refs:proofReferences(dir,source)};
}
test.each(["source","test"])("a %s artifact is readable through the inbox after saving it outside the checkout",kind=>{
  const {source,dir,refs}=fixture();
  const proof=path.join(dir,"probes/proof.md");fs.writeFileSync(proof,"# Reproduction\nRun the test.\n");
  const input={title:"A checked defect",description:"Reproduction",evidence:[{kind,polarity:"supports",description:"Checked proof",artifacts:["probes/proof.md"]}]};
  const finding=createFindingRecord({repo:source,target:"test",finding:refs.record(input)},source);
  const saved=finding.evidence[0]!.artifacts[0]!;
  expect(saved).toBe(proof);
  expect(readSource({repo:source,target:"test",path:saved},source)).toMatchObject({kind:"artifact",lines:["# Reproduction","Run the test.",""]});
  expect(input.evidence[0]!.artifacts).toEqual(["probes/proof.md"]);
});
test("source references, absolute proofs and line suffixes retain the intended file",()=>{
  const {source,dir,refs}=fixture();fs.writeFileSync(path.join(source,"test.dart"),"source");
  fs.writeFileSync(path.join(dir,"probes/probe.py"),"assert False");
  expect(refs.reference("test.dart:1")).toBe(path.join(source,"test.dart:1"));
  expect(refs.reference("probes/probe.py:1")).toBe(path.join(dir,"probes/probe.py:1"));
  expect(refs.reference(path.join(dir,"probes/probe.py"))).toBe(path.join(dir,"probes/probe.py"));
});
test("missing files and raw working dumps fail before recording test proof",()=>{
  const {dir,refs}=fixture();fs.writeFileSync(path.join(dir,"probes/output.log"),"output");
  expect(()=>refs.reference("missing.md")).toThrow("does not exist");
  expect(()=>refs.record({evidence:[{kind:"test",artifacts:["probes/output.log"]}]})).toThrow("not raw logs");
});

test("the proof-worker MCP persists readable references on records and completed queue results",async()=>{
  const {Client}=await import("@modelcontextprotocol/sdk/client/index.js");
  const {StdioClientTransport}=await import("@modelcontextprotocol/sdk/client/stdio.js");
  const {claimReviewSession,claimReviewWork,completeReviewWork,beginVerification,getReviewSession}=await import("../../findings/queues.mts");
  const {fileURLToPath}=await import("node:url");
  const {source,dir}=fixture(),target="gateway",run="run";
  fs.writeFileSync(path.join(source,"code.ts"),"broken();\n");
  fs.writeFileSync(path.join(dir,"probes/proof.md"),"# Executed reproduction\n");
  const session=claimReviewSession({repo:source,target,run,sets:[{id:"all",principles:[]}]},source);
  const address={repo:source,target,session:session.id};
  const finding=createFindingRecord({...address,finding:{title:"Defect",description:"Claim",origins:[{run,unit:"all",source:"source"}]}},source);
  const claim=claimReviewWork({...address,queue:"all",worker:"reader"},source) as any;
  completeReviewWork({...address,queue:"all",worker:"reader",item:claim.work.id,claim:claim.work.claim.token,result:{findings:[finding.id],investigation:{status:"complete",reason:"Traced source",questions:[{question:"Contract?",answer:"Broken",evidence:["code.ts:1"]}],limits:[]}}},source);
  beginVerification({...address,groups:[{findings:[finding.id],reason:"One defect"}]},source);
  fs.writeFileSync(path.join(dir,"plan.json"),JSON.stringify({root:source,principles:[]}));
  fs.writeFileSync(path.join(dir,"tracking.json"),JSON.stringify({...address,run}));
  const client=new Client({name:"proof-path-test",version:"1"});
  const call=async(name:string,args:Record<string,unknown>)=>{
    const result=await client.callTool({name,arguments:args});
    if(result.isError)throw new Error(JSON.stringify(result.content));
    return JSON.parse((result.content as {text:string}[])[0]!.text);
  };
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL("../../../skills/review/scripts/main.ts",import.meta.url)),"--verification-server",dir,"--job","proof"],env:{PATH:process.env.PATH!,WELLACTUALLY_FINDINGS_HOME:process.env.WELLACTUALLY_FINDINGS_HOME!}}));
    const tools=await client.listTools();
    const schema=tools.tools.find(t=>t.name==="update_finding")!.inputSchema as any;
    expect(schema.properties.patch.properties.assessments.items.required).toEqual(expect.arrayContaining(["author","authorType","conclusion","reason"]));
    const next=await call("claim_review_work",{});
    const saved=await call("update_finding",{id:finding.id,expectedRevision:finding.revision,patch:{evidence:[{id:"E1",kind:"test",polarity:"supports",description:"Ran reproduction",artifacts:["probes/proof.md"]}],assessments:[{id:"A1",author:"proof",authorType:"agent",conclusion:"Supported",reason:"Executed reproduction"}]}});
    expect(saved.evidence[0].artifacts).toEqual([path.join(dir,"probes/proof.md")]);
    await call("complete_review_work",{item:next.work.id,claim:next.work.claim.token,result:{summary:"Verified",proofs:["probes/proof.md"],limits:[],decisions:[{id:finding.id,revision:saved.revision,assessmentIds:["A1"],evidenceIds:["E1"]}]}});
    const completed=getReviewSession(address,source).queues.find(q=>q.id==="verification")!.items[0]!.completed!;
    expect(completed.result.proofs).toEqual([path.join(dir,"probes/proof.md")]);
    expect(readSource({...address,path:saved.evidence[0].artifacts[0]},source).lines).toContain("# Executed reproduction");
  }finally{await client.close();}
},15000);

test("reviewers normalize source artifact paths when creating a finding",()=>{
  const {source,dir}=fixture();fs.writeFileSync(path.join(dir,"context.md"),"External contract context");
  fs.writeFileSync(path.join(dir,"plan.json"),JSON.stringify({root:source,principles:[]}));
  fs.writeFileSync(path.join(dir,"tracking.json"),JSON.stringify({target:"reviewer",run:"r"}));
  fs.writeFileSync(path.join(dir,"jobs.json"),JSON.stringify([{id:"reader",principles:[],parts:[]}]));
  const saved=reviewerAccess(dir,"reader").recordTool("create_finding",{idempotencyKey:"issue",finding:{title:"Defect",description:"Claim",evidence:[{kind:"source",polarity:"supports",description:"Inspected context",artifacts:["context.md"]}]}}) as any;
  const artifact=saved.evidence[0].artifacts[0];expect(artifact).toBe(path.join(dir,"context.md"));
  expect(readSource({repo:source,target:"reviewer",path:artifact},source).lines).toContain("External contract context");
});

test("an external proof with a line suffix authorizes the parsed file the UI requests",()=>{
  const {source,dir}=fixture();const proof=path.join(dir,"probes/proof.md");fs.writeFileSync(proof,"Proof\nDetails\n");
  createFindingRecord({repo:source,target:"line",finding:{title:"Defect",description:"Claim",evidence:[{kind:"test",polarity:"supports",description:"Proof",artifacts:[proof+":2"]}]}},source);
  expect(readSource({repo:source,target:"line",path:proof},source)).toMatchObject({kind:"artifact",lines:["Proof","Details",""]});
  const neighbor=path.join(dir,"probes/neighbor.md");fs.writeFileSync(neighbor,"unrelated");
  expect(()=>readSource({repo:source,target:"line",path:neighbor},source)).toThrow("not a saved artifact");
});
