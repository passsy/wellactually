import type { Ctx, Finding } from "@wellactually/sdk";

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
