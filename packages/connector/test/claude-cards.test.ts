import { afterEach, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../findings/serve/mcp.mts";
import { REVIEW_CARD } from "../../findings/tools.mts";

afterEach(() => vi.unstubAllEnvs());

test.each(["claude", "codex"])("standalone %s MCP advertises cards only on supported hosts", async host => {
  vi.stubEnv("WELLACTUALLY_REVIEW_HOST", host);
  const server = createMcpServer({ repo: "" });
  const client = new Client({ name: "card-policy-test", version: "1" }, {
    capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const { tools } = await client.listTools();
    const { resources } = await client.listResources();
    expect(tools.some(t => t.name === "update_finding")).toBe(true);
    expect(tools.some(t => t.name === "review_status")).toBe(true);
    if (host === "claude") {
      expect(resources).toEqual([]);
      expect(tools.every(t => t._meta?.ui === undefined)).toBe(true);
      expect(tools.some(t => t.name === "set_stage")).toBe(false);
      await expect(client.readResource({ uri: REVIEW_CARD })).rejects.toThrow();
    } else {
      expect(resources.some(r => r.uri === REVIEW_CARD)).toBe(true);
      expect(tools.find(t => t.name === "start_review")?._meta).toMatchObject({ ui: { resourceUri: REVIEW_CARD } });
      expect(tools.some(t => t.name === "set_stage")).toBe(true);
    }
  } finally {
    await client.close();
    await server.close();
  }
});
