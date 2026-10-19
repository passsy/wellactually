/**
 * What a finished trial shows beyond its files: what the hook handed over and
 * which commands the agent ran. Both are read from what the trial stored, so
 * a check built on them is as re-runnable as the rest of scoring.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The advice of every hook call that said something, in order. */
export function injections(runDir: string): string[] {
  let log = '';
  try {
    log = readFileSync(join(runDir, 'injected.log'), 'utf8');
  } catch {
    return [];
  }
  return log
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        const context = (JSON.parse(line) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext;
        return context ? [context] : [];
      } catch {
        return [];
      }
    });
}

/**
 * The shell commands the agent ran, from either CLI's event stream.
 * Claude reports a Bash tool call, Codex a command execution item.
 */
export function commandsRun(runDir: string): string[] {
  let transcript = '';
  try {
    transcript = readFileSync(join(runDir, 'transcript.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const commands: string[] = [];
  for (const line of transcript.split('\n')) {
    let event: {
      type?: string;
      message?: { content?: { type?: string; name?: string; input?: { command?: string } }[] };
      item?: { type?: string; command?: string };
    };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_use' && typeof block.input?.command === 'string') {
        commands.push(block.input.command);
      }
    }
    if (event.item?.type === 'command_execution' && typeof event.item.command === 'string' && event.type === 'item.completed') {
      commands.push(event.item.command);
    }
  }
  return commands;
}
