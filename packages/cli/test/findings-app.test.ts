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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

test("provider ports are distinct and explicit host settings win over inherited provider variables", () => {
  expect(new Set(Object.values(REVIEW_PORTS)).size).toBe(
    Object.keys(REVIEW_PORTS).length,
  );
  expect(
    reviewPort(
      { WELLACTUALLY_REVIEW_HOST: "claude", CODEX_THREAD_ID: "parent" },
      [],
    ),
  ).toBe(8424);
  expect(
    reviewPort(
      { WELLACTUALLY_REVIEW_HOST: "codex", CLAUDE_EFFORT: "medium" },
      [],
    ),
  ).toBe(8425);
  expect(
    reviewPort({}, ["node", "cli", "mcp", "--review-host", "opencode"]),
  ).toBe(8426);
  expect(reviewPort({}, ["node", "cli", "mcp", "--review-host", "pi"])).toBe(
    8427,
  );
  expect(() => reviewPort({ WELLACTUALLY_REVIEW_PORT: "invalid" }, [])).toThrow(
    "port",
  );
});

test("combined MCP serves the live app, occurrence CRUD and provider-specific URLs", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wa-app-"));
  fs.writeFileSync(path.join(repo, "state.ts"), "state();\n");
  const clients: Client[] = [];
  try {
    const ports = await Promise.all([freePort(), freePort()]);
    expect(ports[0]).not.toBe(ports[1]);
    for (const [index, host] of ["claude", "codex"].entries()) {
      const client = new Client(
        { name: "findings-app-test", version: "1" },
        {
          capabilities: {
            extensions: {
              "io.modelcontextprotocol/ui": {
                mimeTypes: ["text/html;profile=mcp-app"],
              },
            },
          },
        },
      );
      clients.push(client);
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            fileURLToPath(new URL("../src/main.ts", import.meta.url)),
            "mcp",
          ],
          cwd: repo,
          env: {
            ...(process.env as Record<string, string>),
            WELLACTUALLY_REVIEW_HOST: host,
            WELLACTUALLY_REVIEW_PORT: String(ports[index]),
          },
        }),
      );
      const tools = await client.listTools();
      expect(tools.tools.find(t=>t.name==="start_review")?.annotations).toMatchObject({openWorldHint:false,destructiveHint:false,idempotentHint:true});
      expect(tools.tools.find(t=>t.name==="start_review")?.description).toContain("Local filesystem operation only");
      for (const removed of [
        "create_candidates",
        "list_candidates",
        "resolve_candidates",
        "create_observation",
        "list_observations",
        "drop_observation",
        "report_finding",
        "export_dismissals",
      ])
        expect(tools.tools.some((t) => t.name === removed)).toBe(false);
      expect(JSON.stringify(tools.tools)).not.toMatch(
        /pascal-findings|Pascal|Level 0|reviewer or tester/,
      );

      expect(tools.tools.some((t) => t.name === "regenerate_views")).toBe(
        false,
      );
      expect(
        tools.tools.find((t) => t.name === "start_review")?._meta,
      ).toMatchObject({ ui: { resourceUri: REVIEW_CARD } });
      expect(
        tools.tools.find((t) => t.name === "review_status")?.annotations
          ?.readOnlyHint,
      ).toBe(true);
      expect(
        (await client.listResources()).resources.some(
          (r) => r.uri === REVIEW_CARD,
        ),
      ).toBe(true);
      const resource = await client.readResource({ uri: REVIEW_CARD });
      expect(resource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
      expect(resource.contents[0]?._meta).toMatchObject({
        "openai/widgetShowCodexWidgetInline": true,
      });
      const target = `app-${host}`;
      const start = await client.callTool({
        name: "start_review",
        arguments: { repo, target },
      });
      expect(start.structuredContent).toMatchObject({
        target,
        findings: [],
        levels: [],
        url: expect.stringContaining(`:${ports[index]}/`),
      });
      // The model receives the same resource identity as the host, without
      // needing a second card-producing call to discover the UI.
      const startText = (start.content as {type:string;text?:string}[]).find(c => c.type === "text");
      expect(startText?.type).toBe("text");
      const started = JSON.parse(startText!.text!);
      expect(started).toMatchObject({repo,target,reviewCard:{resourceUri:REVIEW_CARD}});
      expect(started.reviewCard.resourceUri).toBe(
        (tools.tools.find(t=>t.name==="start_review")?._meta?.ui as {resourceUri:string}).resourceUri,
      );
      const created = await client.callTool({
        name: "create_finding",
        arguments: {
          repo,
          target,
          finding: {
            title: "Incoming issue",
            description: "Problem.\n\nRemedy.",
            priority: "p3",
            origins: [{ run: "live", source: "test", unit: "all" }],
          },
        },
      });
      expect(created.isError).not.toBe(true);
      const record = JSON.parse(
        (created.content as { text: string }[])[0]!.text,
      ) as { id: string; revision: number };
      const inboxUrl = new URL(`http://127.0.0.1:${ports[index]}/api/findings`);
      inboxUrl.searchParams.set("repo", repo);
      inboxUrl.searchParams.set("target", target);
      // The inbox consumes a presentation view, never raw schema-v2 files.
      // A finding is valid before it has any source occurrences.
      expect(await (await fetch(inboxUrl)).json()).toMatchObject([
        {
          findings: [
            {
              id: record.id,
              body: "Problem.\n\nRemedy.",
              anchor: { file: "(no source location)", line: 1 },
              record: { schemaVersion: 2 },
            },
          ],
        },
      ]);
      const occurrence = await client.callTool({
        name: "create_occurrence",
        arguments: {
          repo,
          target,
          occurrence: {
            findingId: record.id,
            locations: [{ file: "state.ts", line: 1 }],
          },
        },
      });
      expect(occurrence.isError).not.toBe(true);
      expect(await (await fetch(inboxUrl)).json()).toMatchObject([
        {
          findings: [
            {
              id: record.id,
              anchor: { file: "state.ts", line: 1 },
              occurrenceSummary: { total: 1, open: 1 },
            },
          ],
        },
      ]);
      const immediate = await client.callTool({
        name: "review_status",
        arguments: { repo, target },
      });
      expect(immediate.structuredContent).toMatchObject({
        findings: [
          {
            id: record.id,
            title: "Incoming issue",
            record: { state: "open" },
            occurrenceSummary: { total: 1, resolved: 0 },
          },
        ],
      });
      const assessed = await client.callTool({
        name: "update_finding",
        arguments: {
          repo,
          target,
          id: record.id,
          expectedRevision: record.revision,
          patch: {
            assessments: [
              {
                author: "reviewer",
                authorType: "agent",
                conclusion: "Source establishes the issue",
                reason: "The guard is missing",
              },
            ],
          },
        },
      });
      expect(assessed.isError).not.toBe(true);
      const status = await client.callTool({
        name: "review_status",
        arguments: { repo, target },
      });
      expect(status.structuredContent).toMatchObject({
        findings: [
          {
            id: record.id,
            record: {
              state: "open",
              assessments: [{ conclusion: "Source establishes the issue" }],
            },
          },
        ],
      });
      const closed = await client.callTool({
        name: "update_finding",
        arguments: {
          repo,
          target,
          id: record.id,
          expectedRevision: 2,
          patch: {
            state: "closed",
            closure: { reason: "rejected", explanation: "Test rejection" },
          },
        },
      });
      expect(closed.isError).not.toBe(true);
      const reopened = await client.callTool({
        name: "update_finding",
        arguments: {
          repo,
          target,
          id: record.id,
          expectedRevision: 3,
          patch: { state: "open", closure: null },
        },
      });
      expect(reopened.isError).not.toBe(true);
      const protectedField = await client.callTool({
        name: "update_finding",
        arguments: {
          repo,
          target,
          id: record.id,
          expectedRevision: 4,
          patch: { id: "changed" },
        },
      });
      expect(protectedField.isError).toBe(true);
      const disposition = await client.callTool({
        name: "update_finding",
        arguments: {
          repo,
          target,
          id: record.id,
          expectedRevision: 4,
          patch: { verdict: "accepted", reportedAt: "2026-11-03T10:00:00Z" },
        },
      });
      expect(disposition.isError).not.toBe(true);
      expect(await (await fetch(inboxUrl)).json()).toMatchObject([
        {
          findings: [
            {
              id: record.id,
              verdict: "accepted",
              reportedAt: "2026-11-03T10:00:00Z",
              record: {
                verdict: "accepted",
                reportedAt: "2026-11-03T10:00:00Z",
              },
            },
          ],
        },
      ]);
      // A fix may span multiple commits. Linking partial work stays open;
      // completion explicitly saves closure and preserves earlier work/triage.
      const partial = await client.callTool({
        name: "update_finding",
        arguments: {repo,target,id:record.id,expectedRevision:5,patch:{links:[{id:"fix-one",kind:"fix-commit",commit:"a".repeat(40)}]}},
      });
      expect(partial.isError).not.toBe(true);
      const partialSaved = await client.callTool({name:"get_finding",arguments:{repo,target,id:record.id}});
      expect(JSON.parse((partialSaved.content as {text:string}[])[0]!.text)).toMatchObject({state:"open",revision:6});
      const finished = await client.callTool({
        name: "update_finding",
        arguments: {repo,target,id:record.id,expectedRevision:6,patch:{
          state:"closed",closure:{reason:"resolved",explanation:"Guard and regression test complete"},
          links:[{id:"fix-one",kind:"fix-commit",commit:"a".repeat(40)},{id:"fix-two",kind:"fix-commit",commit:"b".repeat(40)}],
        }},
      });
      expect(finished.isError).not.toBe(true);
      const completion = await client.callTool({name:"get_finding",arguments:{repo,target,id:record.id}});
      expect(JSON.parse((completion.content as {text:string}[])[0]!.text)).toMatchObject({
        state:"closed",closure:{reason:"resolved"},verdict:"accepted",reportedAt:"2026-11-03T10:00:00Z",
        assessments:[{conclusion:"Source establishes the issue"}],
        links:[{id:"fix-one",commit:"a".repeat(40)},{id:"fix-two",commit:"b".repeat(40)}],
      });
      const occurrences = (await (
        await fetch(
          `http://127.0.0.1:${ports[index]}/api/tools/list_occurrences`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ repo, target, findingId: record.id }),
          },
        )
      ).json()) as { id: string; revision: number }[];
      const resolvedOccurrence = await client.callTool({
        name: "update_occurrence",
        arguments: {
          repo,
          target,
          id: occurrences[0]!.id,
          expectedRevision: occurrences[0]!.revision,
          patch: {
            state: "closed",
            closure: { reason: "resolved", explanation: "Fixed" },
          },
        },
      });
      expect(resolvedOccurrence.isError).not.toBe(true);
      expect(await (await fetch(inboxUrl)).json()).toMatchObject([
        {
          findings: [
            {
              id: record.id,
              resolution: "resolved",
              verdict: "accepted",
              reportedAt: "2026-11-03T10:00:00Z",
              record: { state: "closed", closure: { reason: "resolved" } },
            },
          ],
        },
      ]);
      const reviewDir = path.join(repo, ".well-actually", target);
      expect(fs.readdirSync(path.join(reviewDir, "findings"))).toEqual([
        `${record.id}.json`,
      ]);
      expect(fs.existsSync(path.join(reviewDir, "review.html"))).toBe(false);
      expect(fs.existsSync(path.join(reviewDir, "findings.sarif"))).toBe(false);
    }
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
}, 20000);

test("a text-only MCP client receives usable inbox links without a claim of rendered card delivery", async () => {
  const repo=fs.mkdtempSync(path.join(os.tmpdir(),"wa-headless-card-"));
  const client=new Client({name:"headless-card-test",version:"1"},{capabilities:{}});
  const port=await freePort();
  try {
    await client.connect(new StdioClientTransport({
      command:process.execPath,
      args:[fileURLToPath(new URL("../src/main.ts",import.meta.url)),"mcp"],
      cwd:repo,
      env:{...(process.env as Record<string,string>),WELLACTUALLY_REVIEW_PORT:String(port),WELLACTUALLY_REVIEW_HOST:"claude"},
    }));
    const started=await client.callTool({name:"start_review",arguments:{repo,target:"headless"}});
    expect(started.isError).not.toBe(true);
    expect(started.structuredContent).toBeUndefined();
    const body=JSON.parse((started.content as {text:string}[])[0]!.text);
    expect(body.reviewCard).toMatchObject({resourceUri:REVIEW_CARD,delivery:"unconfirmed"});
    const inbox=new URL(body.url);
    expect(inbox.port).toBe(String(port));
    expect(inbox.searchParams.get("repo")).toBe(repo);
    expect(inbox.searchParams.get("target")).toBe("headless");
    expect((await fetch(body.link)).status).toBe(200);
  } finally {
    await client.close();
    fs.rmSync(repo,{recursive:true,force:true});
  }
});
