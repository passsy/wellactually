/**
 * What the types of the handlers of detector API 4 accept and refuse, beyond
 * what version 3 did. Nothing runs this file: `npm run typecheck` compiles it.
 */
import { onDelete, onPrompt, onRead, onWrite, type FileEvent, type Finding } from "@wellactually/sdk/v4";
onWrite({ detect: (event) => event.removed.filter((removed) => removed.text.includes("test(")) });
onWrite({ *detect(event) { yield* event.written; yield* event.removed; yield { line: 2, endLine: 3, removed: true, match: "test(" }; } });
onDelete({ globs: ["test/**"], *detect(event) { yield {}; yield { line: event.lines.length, removed: true }; yield* event.removed; } });
onDelete({ detect: (event) => (event.file.isNew ? [] : [{ match: event.file.name }]) });
// A helper that judges removed lines serves a write and a deletion alike.
const removedTests = (event: Extract<FileEvent, { removed: unknown }>): Finding[] => event.removed.filter((removed) => removed.text.includes("test("));
onWrite({ detect: removedTests });
onDelete({ detect: removedTests });
// @ts-expect-error a read removed nothing
onRead({ detect: (event) => event.removed });
// @ts-expect-error a deletion wrote nothing
onDelete({ detect: (event) => event.written });
// @ts-expect-error a prompt has no lines, removed or not
onPrompt({ *detect(event) { yield { match: event.text }; yield { removed: true }; } });
// @ts-expect-error removed is true or false
onWrite({ *detect() { yield { line: 1, removed: "yes" }; } });
