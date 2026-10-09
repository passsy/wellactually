import type { DetectOptions } from "./events.js";
import type { Ctx, Finding } from "./index.js";
export { command, edit, prompt, read, source, write, type DetectOptions } from "./events.js";
/**
 * What the detector reports for an event: the findings that passed the host's checks.
 *
 * It is empty when the detector's `events` or `globs` do not select the event,
 * exactly as in a session. It throws when the detector fails or reports a
 * finding the host would drop, so a test cannot pass on a broken detector.
 *
 * The principle is the one whose folder the calling test file is in.
 */
export declare function detect(event: Ctx, options?: DetectOptions): Finding[];
