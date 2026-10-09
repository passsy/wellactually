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
/**
 * The agent edited a file. `content` is the file after the edit and
 * `change.written` is the text the agent put in, as one piece or several.
 */
export declare function edit(path: string, content: string, change: {
    written: string | readonly string[];
}): Ctx;
/** The agent read this file. It wrote none of it. */
export declare function read(path: string, content: string): Ctx;
/** The user typed this. */
export declare function prompt(text: string): Ctx;
/** The agent is about to run this shell command. */
export declare function command(text: string): Ctx;
/**
 * A multi-line string without the indentation of the test around it.
 *
 * `${` and a backtick inside it need a backslash, as in any template string.
 */
export declare function source(strings: TemplateStringsArray, ...values: unknown[]): string;
