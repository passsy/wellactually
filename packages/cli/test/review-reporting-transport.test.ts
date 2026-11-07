import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createServer as createPortProbe } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "vitest";

test("packaged MCP aggregation delivers the pinned issue once and exposes acknowledgement", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-report-transport-"));
  const home = path.join(root, "home"), repo = path.join(root, "repo");
  fs.mkdirSync(home); fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, "a.ts"), "class Example {}\n");
  const hash = "c".repeat(64), received = new Map<string, unknown>();
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk;
    if (request.url !== "/api/review-events") { response.writeHead(404); response.end(); return; }
    const body = JSON.parse(text); let stored = 0, duplicates = 0;
    for (const event of body.events) {
      const key = `${event.type}:${event.id}:${event.principle}`;
      if (received.has(key)) duplicates++; else { stored++; received.set(key, event); }
    }
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ stored, duplicates, rejected: [] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const registry = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ registry, token: "test-only", handle: "tester", stats: true }));
  fs.writeFileSync(path.join(home, "board.json"), JSON.stringify({ syncedAt: null, entries: [{ id: "expert/docs", version: 2, hash, enabled: true }] }));
  const client = new Client({ name: "suggestion-transport-test", version: "1" });
  const probe = createPortProbe();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const uiPort = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: { repo, target: "test", ...args } });
    const value = (result.content as { type: string; text?: string }[]).find(c => c.type === "text")!.text!;
    if (result.isError) throw new Error(value);
    return JSON.parse(value);
  };
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../../../dist/wellactually.mjs", import.meta.url)), "mcp"], env: {
      PATH: process.env.PATH!, WELLACTUALLY_HOME: home, WELLACTUALLY_FINDINGS_HOME: path.join(root, "index"), WELLACTUALLY_TOKEN: "", WELLACTUALLY_REVIEW_PORT: String(uiPort),
    } }));
    const session = await call("claim_review_session", { run: "transport", sets: [{ id: "all", principles: [{ id: "expert/docs", version: 2 }] }] });
    const created = await call("create_candidates", { run: "transport", candidates: [{ source: "docs", unit: "all", title: "Documentation absent", body: "No documentation.\n\nAdd it.", evidence: "Reasoned", priority: "p2", rule: "expert/docs", anchor: { file: "a.ts", line: 1 } }] });
    expect(created.errors).toEqual([]);
    for (let i = 0; i < 2; i++) {
      const work = await call("claim_review_work", { session: session.id, queue: "all", worker: "reviewer" });
      await call("complete_review_work", { session: session.id, queue: "all", worker: "reviewer", item: work.work.id, claim: work.work.claim.token, result: {
        ...(work.work.kind === "principle" ? { verdict: "followed", where: "a.ts:1" } : {}), findings: [], investigation: { status: "complete", reason: "Read source", questions: [{ question: "Documented?", answer: "No", evidence: ["a.ts:1"] }], limits: [] },
      } });
    }
    const grouped = await call("begin_verification", { session: session.id, groups: [{ candidates: ["C1"], reason: "One issue" }] });
    expect(grouped.suggestions.count).toBe(1);
    await call("report_review_suggestions");
    await expect.poll(async () => (await call("get_review_session", { session: session.id })).suggestions.sentAt, { timeout: 3000 }).toBeTruthy();
    expect([...received.values()]).toEqual(expect.arrayContaining([
      { id: expect.any(String), type: "review_selection", principle: "expert/docs", revision: 2, occurred_at: expect.any(String) },
      { id: expect.stringMatching(/^[a-f0-9]{64}$/), type: "review_suggestion", principle: "expert/docs", revision: 2, occurred_at: expect.any(String), priority: "p2" },
    ]));
    expect(received.size).toBe(2);
    const status = await call("get_review_session", { session: session.id });
    expect(status.queues.at(-1).completed).toBe(0); // Upload happened before investigation.
  } finally {
    await client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 20000);
