import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { build } from "esbuild";
import { buildBundle } from "@wellactually/core/node";
import { API_VERSION } from "@wellactually/sdk";
import { afterEach, expect, test, vi } from "vitest";
import { writeCached, writeLockfile } from "../src/board/board.ts";
const roots:string[]=[];
const previous=process.env.WELLACTUALLY_HOME;
afterEach(()=>{ if(previous===undefined)delete process.env.WELLACTUALLY_HOME;else process.env.WELLACTUALLY_HOME=previous;roots.splice(0).forEach(root=>fs.rmSync(root,{recursive:true,force:true})); });
test("the independent hook bundle emits advice and logs without importing review or MCP code",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"wa-hook-entry-"));roots.push(root);
  process.env.WELLACTUALLY_HOME=path.join(root,"home");
  const bundle=await buildBundle({"detector.ts":'import {onPrompt} from "@wellactually/sdk/v3";onPrompt({detect:()=>[{match:"enum"}]});'});
  const hash="b".repeat(64),manifest={title:"No enums",summary:"Avoid enums",tags:[],events:["prompt" as const],globs:[],handlers:[{event:"prompt" as const,globs:[]}],api:API_VERSION};
  writeCached({id:"local/no-enums",version:1,hash,manifest,advice:"Use a sealed class.",bundle});
  writeLockfile({syncedAt:null,entries:[{id:"local/no-enums",version:1,hash,enabled:true}]});
  const outfile=path.join(root,"wellactually-hook.mjs");
  const built=await build({entryPoints:[path.resolve(import.meta.dirname,"../src/hook-entry.ts")],outfile,bundle:true,platform:"node",format:"esm",external:["esbuild"],metafile:true,banner:{js:'import {createRequire as __createRequire} from "node:module";const require=__createRequire(import.meta.url);'}});
  expect(Object.keys(built.metafile!.inputs).some(p=>p.includes("/findings/")||p.endsWith("/mcp.ts"))).toBe(false);
  const payload=JSON.stringify({hook_event_name:"UserPromptSubmit",session_id:"hook-smoke",cwd:root,prompt:"add enum",agent:"codex"});
  const result=await new Promise<{stdout:string;stderr:string}>((resolve,reject)=>{
    const child=execFile(process.execPath,[outfile],{env:{...process.env,WELLACTUALLY_WORKERS:"0",WELLACTUALLY_GIT:"0"}},(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr}));child.stdin!.end(payload);
  });
  expect(result.stdout).toContain("<wellactually>");expect(result.stdout).toContain("Use a sealed class.");expect(result.stderr).toBe("");
  await vi.waitFor(()=>{
    const log=fs.readdirSync(path.join(root,"home/logs")).find(p=>p.endsWith(".jsonl"))!;
    expect(JSON.parse(fs.readFileSync(path.join(root,"home/logs",log),"utf8")).shown).toBeGreaterThan(0);
  });
},15000);
