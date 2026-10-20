/**
 * What the types of the handlers accept and refuse. Nothing runs this file:
 * `npm run typecheck` compiles it, and a line marked as an expected error
 * that compiles is itself an error.
 */
import { findUp, mentioned, onCommand, onOutput, onPrompt, onRead, onWrite, type Finding } from "@wellactually/sdk/v3";
onPrompt({ *detect(event) { yield { match: event.text }; yield {}; yield { depth: "pointer" }; } });
onPrompt({ detect: (event) => mentioned(event, ["a"]) });
onPrompt({ *detect(event) { yield* mentioned(event, ["a"]); if (event.text) { return; } yield { match: "a" }; } });
onPrompt({ detect: () => [] });
onPrompt({ detect: () => undefined });
onCommand({ detect: () => {} });
onWrite({ globs: ["a"], *detect(event) { yield* mentioned(event, ["a"]); yield { line: event.written[0]?.line }; yield { line: 1, endLine: 2, match: event.file.name, depth: "full" }; } });
onRead({ detect: (event) => [{ line: event.lines.length }] });
onOutput({ detect: (event) => event.lines.map((_, index) => ({ line: index + 1, match: event.command })) });
onWrite({ *detect(event): Generator<Finding> { yield { line: 1 }; } });
onWrite({ globs: ["a"], detect: (event) => event.written.filter((written) => written.text.includes("late")) });
onWrite({ detect: (event) => (event.lines.length > 3 ? event.written : []) });
// @ts-expect-error a written line has its text, and nothing blanked
onWrite({ detect: (event) => event.written.filter((written) => written.code) });
onRead({ detect: (event) => event.lines.map((_, index) => ({ line: index + 1 })) });
onPrompt({ detect: (event) => (findUp("pubspec.yaml", event.cwd) ? mentioned(event, ["a"]) : []) });
onCommand({ detect: (event) => [{ match: event.cwd }] });
onWrite({ detect: (event) => (event.file.isNew ? event.written : [{ line: 1 }]) });
onWrite({
  *detect(event) {
    for (const written of event.written) {
      yield written;
    }
    yield { line: 1, endLine: 2 };
  },
});
// @ts-expect-error only a write has written lines
onRead({ detect: (event) => event.written });
// @ts-expect-error a prompt has no line
onPrompt({ *detect(event) { yield { match: event.text }; yield { line: 1 }; } });
// @ts-expect-error a command has no line
onCommand({ detect: (event) => [{ match: event.text, endLine: 2 }] });
// @ts-expect-error a depth is pointer or full
onPrompt({ *detect() { yield { depth: "loud" }; } });
// @ts-expect-error a finding carries no text of its own
onWrite({ *detect(event) { yield { line: 1, evidence: "x" }; yield {}; } });
// @ts-expect-error a handler returns findings, not whether it fired
onWrite({ detect: () => true });
// @ts-expect-error a line is a number
onRead({ globs: ["a"], detect: () => [{ line: "1" }] });
// @ts-expect-error a prompt has no file
onPrompt({ detect: (event) => event.file });
// @ts-expect-error a file event has no session folder, it has the path of its file
onWrite({ detect: (event) => [{ match: event.cwd }] });
onWrite({
  *detect(event) {
    if (event.file.isNew) {
      yield {};
      return;
    }
    for (const written of event.written) {
      yield { line: written.line };
    }
  },
});
onRead({ *detect(event) { yield {}; yield { line: 1, endLine: 2 }; yield { match: event.file.name }; } });
onOutput({ *detect() { yield {}; yield { line: 1 }; } });
onWrite({ *detect(event) { yield { line: 1, file: "assets/hero.jpg" }; yield { file: event.file.path }; } });
onCommand({ *detect(event) { yield { file: "hero.jpg", match: event.command }; } });
// @ts-expect-error a file is a path
onOutput({ *detect() { yield { file: 1 }; } });
// @ts-expect-error removed lines came with version 4
onWrite({ detect: (event) => event.removed });
