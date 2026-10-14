import { findUp, mentioned, onPrompt, onWrite } from "@wellactually/sdk/v3";

/**
 * Bare "late" is out of the word list. In conversation it is almost always
 * about time ("too late", "later than expected"), so only the phrases that
 * are unambiguously about the keyword count, plus the runtime error a user
 * pastes when a late field bit them.
 */
onPrompt({
  *detect(event) {
    if (findUp("pubspec.yaml", event.cwd)) {
      yield* mentioned(event, ["late keyword", "late final", "late var", "late initialization", "LateInitializationError"]);
    }
  },
});

// Only a `late` the agent writes; legacy late fields stay unjudged.
// The exceptions below are questions about the whole file, so each `late` is
// looked at by its offset in the code of the file.
onWrite({
  globs: ["**/*.dart", "!**/*.{g,freezed,gr,config,mocks}.dart"],
  *detect(event) {
    // Comment lines are blanked at their length, so a brace in a comment
    // opens no scope and every offset stays where it is.
    const codeLines: string[] = [];
    for (const line of event.lines) {
      if (line.trim().startsWith("//")) {
        codeLines.push(" ".repeat(line.length));
      } else {
        codeLines.push(line);
      }
    }
    const code = codeLines.join("\n");
    for (const written of event.written) {
      // A comment is not code the agent wrote.
      if (written.text.trim().startsWith("//")) {
        continue;
      }
      const column = /(?<![\p{L}\p{N}_$.])late(?![\p{L}\p{N}_$])/u.exec(written.text)?.index;
      if (column === undefined) {
        continue;
      }
      let lineStart = 0;
      for (const line of event.lines.slice(0, written.line - 1)) {
        lineStart += line.length + 1;
      }
      const lateAt = lineStart + column;
      if (isSelfReferentialLocalConstruction(code, lateAt)) {
        continue;
      }
      if (isLazyStateFieldRequiringThis(code, lateAt)) {
        continue;
      }
      if (isLazyBeaconControllerField(code, lateAt)) {
        continue;
      }
      if (isStateLifecycleField(code, lateAt)) {
        continue;
      }
      yield { line: written.line };
    }
  },
});

interface ClassBody {
  open: number;
  close: number;
  isFlutterState: boolean;
  hasBeaconController: boolean;
}

/**
 * `late final item; item = Item(onDismissed: () => remove(item));` is the one
 * local cycle that cannot be expressed with an ordinary final initializer:
 * the callback needs the value while that value is still being constructed.
 */
function isSelfReferentialLocalConstruction(code: string, lateAt: number): boolean {
  if (!isLocal(code, lateAt)) {
    return false;
  }

  const declarationEnd = statementEnd(code, lateAt);
  if (declarationEnd === -1) {
    return false;
  }
  const declaration = code.slice(lateAt, declarationEnd).trim();
  if (!/^late\s+final\b/.test(declaration) || declaration.includes("=")) {
    return false;
  }

  const name = /([A-Za-z_$][\w$]*)\s*;$/.exec(declaration)?.[1];
  if (!name) {
    return false;
  }

  const afterDeclaration = code.slice(declarationEnd);
  const assignment = new RegExp(`^\\s*${escapeRegExp(name)}\\s*=(?!=)`).exec(afterDeclaration);
  if (!assignment) {
    return false;
  }

  const assignmentAt = declarationEnd + assignment.index;
  const assignmentEnd = statementEnd(code, assignmentAt);
  if (assignmentEnd === -1) {
    return false;
  }
  const equalsAt = code.indexOf("=", assignmentAt);
  const initializer = code.slice(equalsAt + 1, assignmentEnd - 1);
  if (!isConstructorCall(initializer)) {
    return false;
  }

  return callbackCaptures(initializer, name);
}

/**
 * A direct field initializer cannot normally use `this`. A `late final` field
 * makes that initializer lazy, which is legitimate for State-owned resources
 * such as `AnimationController(vsync: this)`.
 */
function isLazyStateFieldRequiringThis(code: string, lateAt: number): boolean {
  const body = enclosingClass(code, lateAt);
  if (!body?.isFlutterState || braceDepth(code, body.open + 1, lateAt) !== 0) {
    return false;
  }

  const end = statementEnd(code, lateAt);
  if (end === -1) {
    return false;
  }
  const declaration = code.slice(lateAt, end);
  if (!/^late\s+final\b/.test(declaration)) {
    return false;
  }

  const equalsAt = declaration.indexOf("=");
  return equalsAt !== -1 && /(?<![\p{L}\p{N}_$.])this(?![\p{L}\p{N}_$])/u.test(declaration.slice(equalsAt + 1));
}

/**
 * State Beacon controllers own `B` as an instance field. Their beacons must be
 * lazy fields so the initializer can use that group and join its disposal.
 */
function isLazyBeaconControllerField(code: string, lateAt: number): boolean {
  const body = enclosingClass(code, lateAt);
  if (!body?.hasBeaconController || braceDepth(code, body.open + 1, lateAt) !== 0) {
    return false;
  }

  const end = statementEnd(code, lateAt);
  if (end === -1) {
    return false;
  }
  const declaration = code.slice(lateAt, end);
  if (!/^late\s+final\b/.test(declaration)) {
    return false;
  }

  const equalsAt = declaration.indexOf("=");
  return equalsAt !== -1 && /\bB\s*\./.test(declaration.slice(equalsAt + 1));
}

/**
 * `late final _controller;` in a State class, assigned in `initState()`.
 * Flutter runs initState before build, so the field cannot be read early.
 * Not in the handbook runtime, which leaves this exception to the reader.
 */
function isStateLifecycleField(code: string, lateAt: number): boolean {
  const body = enclosingClass(code, lateAt);
  if (!body?.isFlutterState || braceDepth(code, body.open + 1, lateAt) !== 0) {
    return false;
  }
  const end = statementEnd(code, lateAt);
  if (end === -1) {
    return false;
  }
  const declaration = code.slice(lateAt, end).trim();
  if (!/^late\s+final\b/.test(declaration) || declaration.includes("=")) {
    return false;
  }
  const name = /([A-Za-z_$][\w$]*)\s*;$/.exec(declaration)?.[1];
  if (!name) {
    return false;
  }
  const classCode = code.slice(body.open, body.close);
  const initState = /\bvoid\s+initState\s*\(\s*\)\s*\{/.exec(classCode);
  if (!initState) {
    return false;
  }
  const open = initState.index + initState[0].length - 1;
  const close = matchingBrace(classCode, open);
  if (close === -1) {
    return false;
  }
  return new RegExp(`(?<![\\w$])${escapeRegExp(name)}\\s*=(?!=)`).test(classCode.slice(open, close));
}

function isLocal(code: string, offset: number): boolean {
  const body = enclosingClass(code, offset);
  if (body) {
    return braceDepth(code, body.open + 1, offset) > 0;
  }
  return braceDepth(code, 0, offset) > 0;
}

function enclosingClass(code: string, offset: number): ClassBody | null {
  let innermost: ClassBody | null = null;
  const declaration = /\bclass\s+[A-Za-z_$][\w$]*/g;
  for (const match of code.matchAll(declaration)) {
    const at = match.index ?? -1;
    const open = code.indexOf("{", at);
    if (open === -1 || open > offset) {
      continue;
    }
    const close = matchingBrace(code, open);
    if (close === -1 || offset >= close) {
      continue;
    }
    if (innermost && open <= innermost.open) {
      continue;
    }
    innermost = {
      open,
      close,
      isFlutterState: /\bextends\s+State\s*(?:<[^{}]*>)?/.test(code.slice(at, open)),
      hasBeaconController: /\bwith\b[^{}]*\bBeaconController(?:Mixin)?\b/.test(code.slice(at, open)),
    };
  }
  return innermost;
}

function callbackCaptures(initializer: string, name: string): boolean {
  let at = initializer.indexOf("=>");
  while (at !== -1) {
    if (looksLikeCallbackParameters(initializer, at)) {
      const end = arrowBodyEnd(initializer, at + 2);
      if (usesName(initializer.slice(at + 2, end), name)) {
        return true;
      }
    }
    at = initializer.indexOf("=>", at + 2);
  }

  for (let open = initializer.indexOf("{"); open !== -1; open = initializer.indexOf("{", open + 1)) {
    if (!looksLikeCallbackParameters(initializer, open)) {
      continue;
    }
    const close = matchingBrace(initializer, open);
    if (close !== -1 && usesName(initializer.slice(open + 1, close), name)) {
      return true;
    }
  }
  return false;
}

function looksLikeCallbackParameters(code: string, bodyAt: number): boolean {
  let end = bodyAt - 1;
  while (end >= 0 && /\s/.test(code[end] ?? "")) {
    end--;
  }

  let start = end;
  if (code[end] === ")") {
    start = matchingOpenParen(code, end);
    if (start === -1) {
      return false;
    }

    const before = previousNonSpace(code, start - 1);
    return before === -1 || ":,=([{\n".includes(code[before] ?? "");
  }

  while (start >= 0 && /[A-Za-z0-9_$]/.test(code[start] ?? "")) {
    start--;
  }
  start++;
  if (start > end) {
    return false;
  }

  const before = previousNonSpace(code, start - 1);
  return before === -1 || ":,=([{\n".includes(code[before] ?? "");
}

function arrowBodyEnd(code: string, from: number): number {
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let i = from; i < code.length; i++) {
    const char = code[i];
    const topLevel = parentheses === 0 && brackets === 0 && braces === 0;
    switch (char) {
      case "(":
        parentheses++;
        break;
      case ")":
        if (topLevel) {
          return i;
        }
        parentheses--;
        break;
      case "[":
        brackets++;
        break;
      case "]":
        if (topLevel) {
          return i;
        }
        brackets--;
        break;
      case "{":
        braces++;
        break;
      case "}":
        if (topLevel) {
          return i;
        }
        braces--;
        break;
      case ",":
      case ";":
        if (topLevel) {
          return i;
        }
        break;
    }
  }
  return code.length;
}

function isConstructorCall(initializer: string): boolean {
  return /^\s*(?:const\s+)?(?:[A-Za-z_$][\w$]*\.)*[A-Z_$][\w$]*(?:\s*<[^;(){}]+>)?(?:\.[A-Za-z_$][\w$]*)?\s*\(/.test(initializer);
}

/** Index just after the statement's top-level semicolon. */
function statementEnd(code: string, from: number): number {
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let i = from; i < code.length; i++) {
    const char = code[i];
    const topLevel = parentheses === 0 && brackets === 0 && braces === 0;
    switch (char) {
      case "(":
        parentheses++;
        break;
      case ")":
        parentheses--;
        break;
      case "[":
        brackets++;
        break;
      case "]":
        brackets--;
        break;
      case "{":
        braces++;
        break;
      case "}":
        braces--;
        break;
      case ";":
        if (topLevel) {
          return i + 1;
        }
        break;
    }
  }
  return -1;
}

function matchingBrace(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    switch (code[i]) {
      case "{":
        depth++;
        break;
      case "}":
        depth--;
        if (depth === 0) {
          return i;
        }
        break;
    }
  }
  return -1;
}

function matchingOpenParen(code: string, close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    switch (code[i]) {
      case ")":
        depth++;
        break;
      case "(":
        depth--;
        if (depth === 0) {
          return i;
        }
        break;
    }
  }
  return -1;
}

function braceDepth(code: string, from: number, to: number): number {
  let depth = 0;
  for (let i = from; i < to; i++) {
    switch (code[i]) {
      case "{":
        depth++;
        break;
      case "}":
        depth--;
        break;
    }
  }
  return depth;
}

function previousNonSpace(code: string, from: number): number {
  let at = from;
  while (at >= 0 && /\s/.test(code[at] ?? "")) {
    at--;
  }
  return at;
}

/** Whether `code` uses `name` as a word of its own: not as part of a longer name, and not as a member of something else. */
function usesName(code: string, name: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}_$.])${escapeRegExp(name)}(?![\\p{L}\\p{N}_$])`, "u").test(code);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
