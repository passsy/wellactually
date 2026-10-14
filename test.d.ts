import type { DetectOptions } from "./events.js";
import type { Ctx, Finding } from "./index.js";
export { command, edit, output, prompt, read, source, write, type DetectOptions } from "./events.js";
/**
 * What the detector reports for an event: the findings that passed the host's checks.
 *
 * It is empty when no handler of the detector wants the event, exactly as in
 * a session. It throws when the detector fails or reports something the host
 * would drop, so a test cannot pass on a broken detector.
 *
 * The principle is the one whose folder the calling test file is in.
 */
export declare function detect(event: Ctx, options?: DetectOptions): Finding[];
