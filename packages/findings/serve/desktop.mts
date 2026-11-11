/** Read-only Desktop connector. No authoring tools or HTTP server are started. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve } from "node:path";
import { listReviews, reviewStatus } from "../api.mts";
import { readRegistry } from "../store/registry.mts";
import { slugTarget, targetPaths } from "../store/paths.mts";
import { occurrenceRecords } from "../store/records.mts";
import { CARD_MIME, registerReviewCard } from "./app.mts";
import { reviewCardsEnabled } from "./port.mts";
import { REVIEW_CARD } from "../tools.mts";

export function createDesktopServer(): McpServer {
  const server = new McpServer({ name: "wellactually-reader", version: "1.0.0" });
  registerReviewCard(server);
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const selection = { repo: z.string().min(1), target: z.string().min(1) };
  function registered(args: { repo: string; target: string }) {
    const repo = resolve(args.repo), target = slugTarget(args.target);
    if (!readRegistry().repos.some(entry => resolve(entry.path) === repo && entry.targets.includes(target))) {
      throw new Error("Review is not registered. Use list_reviews to select an existing Well Actually review.");
    }
    return { repo, target };
  }
  server.registerTool("list_reviews", {
    description: "List existing Well Actually reviews on this machine. Select repo and target, then call review_status to show a live read-only card. Reviews run in the coding session; this connector only reads their saved results.",
    inputSchema: {}, annotations,
  }, async () => ({ content: [{ type: "text", text: JSON.stringify(listReviews()) }] }));
  server.registerTool("review_status", {
    description: "Show a live read-only Well Actually review card. Use repo and target from list_reviews. No findings, notes, decisions or code can be changed through this connector.",
    inputSchema: selection, annotations,
    ...(reviewCardsEnabled() ? { _meta: { ui: { resourceUri: REVIEW_CARD, visibility: ["model", "app"] } } } : {}),
  }, async args => {
    const selected = registered(args);
    const status = { ...reviewStatus(selected, selected.repo), readOnly: true };
    return { content: [{ type: "text", text: `${status.title ?? status.target}: ${status.findings.length} findings (${status.state}). ${reviewCardsEnabled() ? "Read-only live card." : `Inline cards disabled. Review inbox: ${status.url}`}` }], ...(reviewCardsEnabled() ? { structuredContent: status } : {}) };
  });
  server.registerTool("list_occurrences", {
    description: "Read saved occurrences and captured code for a finding in an existing review.",
    inputSchema: { ...selection, findingId: z.string().min(1) }, annotations,
    _meta: { ui: { visibility: ["app"] } },
  }, async args => {
    const selected = registered(args);
    const occurrences = occurrenceRecords(targetPaths(selected.repo, selected.target)).filter(o => o.findingId === args.findingId);
    return { content: [{ type: "text", text: JSON.stringify(occurrences) }] };
  });
  return server;
}

export async function serveDesktop(): Promise<void> {
  const server = createDesktopServer();
  await server.connect(new StdioServerTransport());
}
