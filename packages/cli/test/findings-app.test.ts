import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "vitest";
import { reviewPort, REVIEW_PORTS } from "../../findings/serve/port.mts";
import { REVIEW_CARD } from "../../findings/tools.mts";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test("provider ports are distinct and explicit host settings win over inherited provider variables", () => {
  expect(new Set(Object.values(REVIEW_PORTS)).size).toBe(Object.keys(REVIEW_PORTS).length);
  expect(reviewPort({ WELLACTUALLY_REVIEW_HOST: "claude", CODEX_THREAD_ID: "parent" }, [])).toBe(8424);
  expect(reviewPort({ WELLACTUALLY_REVIEW_HOST: "codex", CLAUDE_EFFORT: "medium" }, [])).toBe(8425);
  expect(reviewPort({}, ["node", "cli", "mcp", "--review-host", "opencode"])).toBe(8426);
  expect(reviewPort({}, ["node", "cli", "mcp", "--review-host", "pi"])).toBe(8427);
  expect(() => reviewPort({ WELLACTUALLY_REVIEW_PORT: "invalid" }, [])).toThrow("port");
});

test("combined MCP serves the live app, pending candidates and provider-specific URLs", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wa-app-"));
  fs.writeFileSync(path.join(repo, "state.ts"), "state();\n");
  const clients: Client[] = [];
  try {
    const ports = await Promise.all([freePort(), freePort()]);
    expect(ports[0]).not.toBe(ports[1]);
    for (const [index, host] of ["claude", "codex"].entries()) {
      const client = new Client({ name: "findings-app-test", version: "1" }, { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } });
      clients.push(client);
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../src/main.ts", import.meta.url)), "mcp"], cwd: repo, env: { ...process.env as Record<string, string>, WELLACTUALLY_REVIEW_HOST: host, WELLACTUALLY_REVIEW_PORT: String(ports[index]) } }));
      const tools = await client.listTools();
      expect(tools.tools.find(t => t.name === "start_review")?._meta).toMatchObject({ ui: { resourceUri: REVIEW_CARD } });
      expect(tools.tools.find(t => t.name === "review_status")?.annotations?.readOnlyHint).toBe(true);
      expect((await client.listResources()).resources.some(r => r.uri === REVIEW_CARD)).toBe(true);
      const resource = await client.readResource({ uri: REVIEW_CARD });
      expect(resource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
      expect(resource.contents[0]?._meta).toMatchObject({ "openai/widgetShowCodexWidgetInline": true });
      const target = `app-${host}`;
      const start = await client.callTool({ name: "start_review", arguments: { repo, target } });
      expect(start.structuredContent).toMatchObject({ target, findings: [], candidates: [], url: expect.stringContaining(`:${ports[index]}/`) });
      const created = await client.callTool({ name: "create_candidates", arguments: { repo, target, run: "live", candidates: [{ source: "test", unit: "all", title: "Incoming issue", body: "Problem.\n\nRemedy.", priority: "p3", evidence: "Reasoned", anchor: { file: "state.ts", line: 1 } }] } });
      expect(created.isError).not.toBe(true);
      const pending = await client.callTool({ name: "review_status", arguments: { repo, target } });
      expect(pending.structuredContent).toMatchObject({ findings: [], candidates: [{ id: "C1", title: "Incoming issue", status: "pending" }] });
      await client.callTool({ name: "resolve_candidates", arguments: { repo, target, decisions: [{ id: "C1", status: "confirmed", reason: "Source evidence" }] } });
      const verified = await client.callTool({ name: "review_status", arguments: { repo, target } });
      expect(verified.structuredContent).toMatchObject({ candidates: [], findings: [{ title: "Incoming issue", verification: { status: "confirmed" } }] });
    }
  } finally { await Promise.all(clients.map(client => client.close())); }
}, 20000);
