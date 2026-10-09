import type { Ctx, EventName, Finding } from "@wellactually/sdk";

export const api = 2;
export const events: EventName[] = ["command"];

const PREFIX = /(?:-m|--message)[= ]+["'](?:feat|fix|chore|docs|refactor|test|style|perf|build|ci|revert)(?:\([^)"']*\))?!?:/;

export function* detect(ctx: Ctx): Generator<Finding> {
  if (!ctx.isCommand || !/\bgit\b[^|;&]*\bcommit\b/.test(ctx.text)) {
    return;
  }
  const match = PREFIX.exec(ctx.text);
  if (!match) {
    return;
  }
  yield { evidence: match[0] };
}
