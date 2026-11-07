import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDesktopServer } from '../../findings/serve/desktop.mts';
import { startReview } from '../../findings/api.mts';
import { createFindingRecord, createOccurrence } from '../../findings/crud.mts';
import * as registry from '../../findings/store/registry.mts';

test('Desktop reader streams new saved results and rejects writes and unregistered paths', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-reader-'));
  const target = 'reader-test';
  const read = vi.spyOn(registry, 'readRegistry').mockReturnValue({repos:[{path:repo, targets:[target], lastReview:new Date().toISOString()}]});
  const write = vi.spyOn(registry, 'upsertRegistry').mockImplementation(() => read());
  fs.writeFileSync(path.join(repo, 'example.ts'), 'const result = calculate();\n');
  const server = createDesktopServer();
  const client = new Client({name:'reader-test',version:'1'}, {capabilities:{}});
  const [a,b] = InMemoryTransport.createLinkedPair();
  try {
    startReview({repo,target},repo);
    await server.connect(a); await client.connect(b);
    const tools = await client.listTools();
    expect(tools.tools.map(t=>t.name).sort()).toEqual(['list_occurrences','list_reviews','review_status']);
    expect(tools.tools.every(t=>t.annotations?.readOnlyHint === true)).toBe(true);
    const initial = await client.callTool({name:'review_status',arguments:{repo,target}});
    expect(initial.structuredContent).toMatchObject({readOnly:true, findings:[]});
    const f = createFindingRecord({repo,target,finding:{title:'Arrived later',description:'Saved after opening card'}},repo);
    createOccurrence({repo,target,occurrence:{findingId:f.id,locations:[{file:'example.ts',line:1}]}},repo);
    const next = await client.callTool({name:'review_status',arguments:{repo,target}});
    expect((next.structuredContent as any).findings[0].title).toBe('Arrived later');
    const occurrences = await client.callTool({name:'list_occurrences',arguments:{repo,target,findingId:f.id}});
    expect(JSON.stringify(occurrences)).toContain('calculate');
    const denied = await client.callTool({name:'review_status',arguments:{repo:os.tmpdir(),target}});
    expect(denied.isError).toBe(true);
    const before = fs.readFileSync(path.join(repo,'.well-actually',target,'findings',f.id+'.json'),'utf8');
    const mutation = await client.callTool({name:'update_finding',arguments:{repo,target,id:f.id,patch:{title:'Changed'}}});
    expect(mutation.isError).toBe(true);
    expect(fs.readFileSync(path.join(repo,'.well-actually',target,'findings',f.id+'.json'),'utf8')).toBe(before);
  } finally {
    await client.close(); await server.close(); read.mockRestore(); write.mockRestore();
    fs.rmSync(repo,{recursive:true,force:true});
  }
});
