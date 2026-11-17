import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "../tools.mts";
import { REVIEW_CARD } from "../tools.mts";
import { cardHtml } from "./web-assets.mts";
import { reviewCardsEnabled } from "./port.mts";

export const CARD_MIME = "text/html;profile=mcp-app";
export const UI_EXTENSION = "io.modelcontextprotocol/ui";

export function drawsCards(server: McpServer): boolean {
  if (!reviewCardsEnabled()) return false;
  const extension = server.server.getClientCapabilities()?.extensions?.[UI_EXTENSION] as { mimeTypes?: unknown } | undefined;
  return Array.isArray(extension?.mimeTypes) && extension.mimeTypes.includes(CARD_MIME);
}

export function appToolMeta(tool: Tool): Record<string, unknown> | undefined {
  if (!reviewCardsEnabled()) return undefined;
  if (!tool.card && !tool.cardOnly) return undefined;
  return { ui: { ...(tool.card ? { resourceUri: tool.card } : {}), ...(tool.cardOnly ? { visibility: ["app"] } : {}) } };
}

export function registerReviewCard(server: McpServer): void {
  if (!reviewCardsEnabled()) return;
  server.registerResource("Review card", REVIEW_CARD, { mimeType: CARD_MIME, description: "Live review findings and occurrence code." }, async () => ({
    contents: [{ uri: REVIEW_CARD, mimeType: CARD_MIME, text: cardHtml(), _meta: { ui: { prefersBorder: false }, "openai/widgetShowCodexWidgetInline": true } }],
  }));
}
