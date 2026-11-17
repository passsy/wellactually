/**
 * The MCP door onto the findings core.
 *
 * A thin wrapper by design: the tool list, the schemas and the descriptions
 * live in tools.mts, and everything this file adds is the protocol. Errors
 * from the core come back as tool errors with their message intact, because
 * the caller is a model that will read it and try again.
 *
 * The one thing here that is not a tool is the review card: an MCP App, which
 * is a `ui://` resource a host renders in the conversation for the tools that
 * name it. A host that knows nothing about that sees the same tools it always
 * did, answering in text.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { REVIEW_CARD, TOOLS, toolNamed } from "../tools.mts";
import { adoptRoots, type Workspace } from "../store/workspace.mts";
import { cardHtml } from "./web-assets.mts";
import { reviewCardsEnabled } from "./port.mts";

/** The MCP Apps extension, and the one kind of resource it defines. */
const UI_EXTENSION = "io.modelcontextprotocol/ui";
const CARD_MIME = "text/html;profile=mcp-app";

export interface McpOptions {
  /**
   * Offer only what the review card needs. For a host that shows reviews and
   * runs none, which is a chat: twenty tools that write a review are twenty
   * things for a model to reach for there, and the session that does run the
   * review already has its own copy of every one.
   */
  cardOnly?: boolean;
}

export function createMcpServer(
  workspace: Workspace,
  options: McpOptions = {},
): Server {
  const server = new Server(
    { name: "wellactually", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  /**
   * Whether the host on the other end draws cards.
   *
   * Asked rather than assumed, because the two answers want different tool
   * results. A host that draws the card keeps what the card is handed away
   * from the model. One that does not would show the model every finding in
   * full on every call, to draw nothing.
   */
  const drawsCards = (): boolean => {
    if (!reviewCardsEnabled()) return false;
    const extension = server.getClientCapabilities()?.extensions?.[
      UI_EXTENSION
    ] as { mimeTypes?: unknown } | undefined;
    return (
      Array.isArray(extension?.mimeTypes) &&
      extension.mimeTypes.includes(CARD_MIME)
    );
  };

  // The client knows where the user is working; this process only knows where
  // it happened to be started. Ask as soon as asking is allowed.
  server.oninitialized = () => {
    if (!server.getClientCapabilities()?.roots) return;
    void server
      .listRoots()
      .then((result) => adoptRoots(workspace, result.roots))
      .catch(() => {
        // A client that advertises roots and then refuses them leaves the
        // working-directory guess in place, which is still usable.
      });
  };

  /** Whether a tool is only ever the card's to call, on this server. */
  const forCardAlone = (tool: (typeof TOOLS)[number]): boolean =>
    tool.cardOnly === true ||
    (options.cardOnly === true && tool.inCardServer === "card");

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.filter(
      (tool) => !options.cardOnly || tool.inCardServer !== undefined,
    )
      // A host that draws no card would hand the card's tools to the model.
      .filter((tool) => !forCardAlone(tool) || drawsCards())
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        ...((tool.card && reviewCardsEnabled()) || forCardAlone(tool)
          ? {
              _meta: {
                ui: {
                  ...(tool.card && reviewCardsEnabled() ? { resourceUri: tool.card } : {}),
                  ...(forCardAlone(tool) ? { visibility: ["app"] } : {}),
                },
              },
            }
          : {}),
      })),
  }));

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: reviewCardsEnabled() ? [
      {
        uri: REVIEW_CARD,
        name: "Review card",
        description:
          "A review's progress and its findings, drawn in the conversation.",
        mimeType: CARD_MIME,
      },
    ] : [],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    if (!reviewCardsEnabled() || request.params.uri !== REVIEW_CARD) {
      throw new Error(`no resource "${request.params.uri}"`);
    }
    return {
      contents: [
        {
          uri: REVIEW_CARD,
          mimeType: CARD_MIME,
          text: cardHtml(),
          _meta: {
            // The card draws its own edge, and a host's frame around it would
            // be a second one.
            ui: { prefersBorder: false },
            // Codex folds a card into an "Opened …" row unless told to draw
            // it in place, and a card nobody opens says no more than a link.
            "openai/widgetShowCodexWidgetInline": true,
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolNamed(request.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `no tool "${request.params.name}". Available: ${TOOLS.map((each) => each.name).join(", ")}.`,
          },
        ],
      };
    }
    try {
      const args = request.params.arguments ?? {};
      // Awaited even though most tools are synchronous: report_finding is
      // not, and a promise handed to JSON.stringify serialises as "{}".
      const result = await tool.run(args, workspace.repo);
      const text = tool.says
        ? tool.says(result)
        : JSON.stringify(result, null, 2);
      if (!tool.card || !drawsCards()) {
        return { content: [{ type: "text" as const, text }] };
      }
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: (tool.forCard
          ? tool.forCard(args, workspace.repo)
          : result) as Record<string, unknown>,
      };
    } catch (error) {
      // The caller is a model that will try again, so the message has to be
      // the correction rather than a stack trace.
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  });

  return server;
}

export async function serveStdio(
  workspace: Workspace,
  options: McpOptions = {},
): Promise<Server> {
  const server = createMcpServer(workspace, options);
  await server.connect(new StdioServerTransport());
  return server;
}
