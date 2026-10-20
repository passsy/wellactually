/**
 * The events a test shows to a detector.
 *
 * They are the same in every runner: vitest on the author's machine,
 * `wellactually test`, the browser editor and the registry. A path is relative
 * to a made-up project root, and the detector sees it below that root.
 */
import { type Ctx } from "./index.js";
/** What `detect` takes besides the event. */
export interface DetectOptions {
    /**
     * A folder of the principle, e.g. "fixtures/flutter_app", that is the
     * project the event happens in. The detector reads its files with `node:fs`.
     * Without it the only file there is, anywhere, is the file of the event.
     */
    project?: string;
}
/**
 * The agent wrote this file in full. Every line counts as written.
 * Pass `{ isNew: true }` when the write created the file.
 */
export declare function write(path: string, content: string, options?: {
    isNew?: boolean;
}): Ctx;
/** What `edit` takes besides the file after the edit. */
export interface EditChange {
    /** The text the agent put in, as one piece or several. */
    written?: string | readonly string[];
    /** The text the agent took out, as one piece or several. Needs `before`, where it is found. */
    removed?: string | readonly string[];
    /** The file as it was before the edit. A removed line has the line it had there. */
    before?: string;
}
/**
 * The agent edited a file. `content` is the file after the edit,
 * `change.written` is the text the agent put in, and `change.removed` the
 * text it took out of `change.before`.
 */
export declare function edit(path: string, content: string, change: EditChange): Ctx;
/** The agent deleted this file. `content` is what it held. Every line of it counts as removed. */
export declare function deleted(path: string, content: string): Ctx;
/** The agent read this file. It wrote none of it. */
export declare function read(path: string, content: string): Ctx;
/** The user typed this, or the agent handed it to a subagent. */
export declare function prompt(text: string): Ctx;
/** The agent is about to run this shell command. */
export declare function command(text: string): Ctx;
/** `command` ran, and this is what it printed. */
export declare function output(command: string, text: string): Ctx;
/**
 * A multi-line string without the indentation of the test around it.
 *
 * `${` and a backtick inside it need a backslash, as in any template string.
 */
export declare function source(strings: TemplateStringsArray, ...values: unknown[]): string;
