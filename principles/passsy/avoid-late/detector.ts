import { blankCommentsAndStrings, findWord, mentioned, writtenLines, type Ctx, type Finding } from "@wellactually/sdk";

/**
 * Bare "late" is not in the word list. In conversation it is almost always
 * about time, so only the phrases that can only mean the keyword count, plus
 * the runtime error a user pastes when a late field bit them.
 */
export function* detect(ctx: Ctx): Generator<Finding> {
  yield* mentioned(ctx, ["late keyword", "late final", "late var", "LateInitializationError"]);

  const file = ctx.file;
  if (!file || file.name.endsWith(".g.dart") || file.name.endsWith(".freezed.dart")) {
    return;
  }

  const code = blankCommentsAndStrings(file.content).split("\n");
  // Only a `late` the agent writes. Legacy late fields stay unjudged.
  for (const written of writtenLines(ctx)) {
    const line = code[written.line - 1] ?? "";
    if (findWord(line, "late") === -1) {
      continue;
    }
    if (isLazyInitializerUsingThis(line)) {
      continue;
    }
    yield { line: written.line, evidence: written.text.trim() };
  }
}

/** `late final x = Foo(vsync: this);` is lazy initialization and cannot throw. */
function isLazyInitializerUsingThis(line: string): boolean {
  const equalsAt = line.indexOf("=");
  if (equalsAt === -1 || !/\blate\s+final\b/.test(line.slice(0, equalsAt))) {
    return false;
  }
  return findWord(line.slice(equalsAt + 1), "this") !== -1;
}
