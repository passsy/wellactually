/**
 * What the types of the handlers of detector API 5 accept and refuse, beyond
 * what version 4 did. Nothing runs this file: `npm run typecheck` compiles it.
 */
import { onCommand, onTool, type ToolEvent } from "@wellactually/detector-sdk/v5";
onTool({ *detect(event) { if (event.tool === "pull_request_create" && typeof event.input.body === "string") { yield { match: "body", depth: "pointer" }; } yield {}; } });
onTool({ detect: (event: ToolEvent) => (event.server === "t3-code" ? [{ file: "README.md" }] : []) });
// @ts-expect-error a tool call has no lines to point at
onTool({ *detect(event) { yield { match: event.tool }; yield { line: 1 }; } });
// @ts-expect-error a shell command is not a tool call
onCommand({ detect: (event) => (event.tool ? [{}] : []) });
