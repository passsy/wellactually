/**
 * The hook a trial runs: the one in this working tree, with the framing an arm
 * asks for.
 *
 * `plugin` arms frame advice the way the client ships it. A `framing:<file>`
 * arm sets WELLACTUALLY_EVAL_FRAMING to a module exporting its own
 * `frameEvents`, so two wordings reach the agent through the same detectors,
 * the same session memory and the same door, and differ only in the words.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { boardHome, frameEvents, readShown, writeShown } from '../../packages/cli/src/board/board.ts';
import { runHook } from '../../packages/cli/src/hook/hook.ts';

// The hook starts `<this file> sync` at session start when the board has a token. There is nothing to sync in a trial.
if (process.argv[2] === 'sync') {
  process.exit(0);
}

const stdin = readFileSync(0, 'utf8');
const candidate = process.env.WELLACTUALLY_EVAL_FRAMING;
const frame = candidate
  ? ((await import(pathToFileURL(candidate).href)) as { frameEvents: typeof frameEvents }).frameEvents
  : frameEvents;

// A case can start its sessions as if the full advice was shown long ago, so the
// first firing is the summary. Once per session and agent, before the hook reads the list.
const seen = process.env.WELLACTUALLY_EVAL_SEEN;
if (seen) {
  const payload = JSON.parse(stdin) as { session_id?: string; agent_id?: string };
  const session = payload.session_id ?? 'unknown';
  const marks = join(boardHome(), 'eval-seen');
  const mark = join(marks, `${session}.${payload.agent_id ?? 'main'}`.replace(/[^A-Za-z0-9_.-]/g, '_'));
  if (!existsSync(mark)) {
    mkdirSync(marks, { recursive: true });
    writeShown(session, new Set([...readShown(session, payload.agent_id), ...seen.split(',')]), payload.agent_id);
    writeFileSync(mark, '');
  }
}

process.stdout.write(await runHook(stdin, undefined, frame));
