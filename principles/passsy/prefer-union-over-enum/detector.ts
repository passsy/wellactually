import { blankCommentsAndStrings, writtenLines, type Ctx, type Finding } from "@wellactually/sdk";

const ENUM = /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+[A-Za-z_$]/;

export function* detect(ctx: Ctx): Generator<Finding> {
  const file = ctx.file;
  if (!file || /\.d\.[cm]?ts$/.test(file.name)) {
    return;
  }
  const code = blankCommentsAndStrings(file.content).split("\n");
  for (const written of writtenLines(ctx)) {
    if (ENUM.test(code[written.line - 1] ?? "")) {
      yield { line: written.line, evidence: written.text.trim() };
    }
  }
}
