/**
 * The run as one page somebody will actually sit and read.
 *
 * The table a run prints answers "did the framing change anything". It cannot
 * answer "why did that trial fail", and the answer to that is spread over ten
 * files in a directory named after a timestamp. This collects a whole run —
 * every verdict, every diff, every transcript — into a single self-contained
 * `report.html` beside `results.json`, so a surprising number is one click from
 * the trial that produced it.
 *
 * Everything is read back off disk rather than handed over by the runner, so
 * the same generator regenerates the page for a run that finished last week:
 *
 *     node lib/page.ts                      # output/latest
 *     node lib/page.ts output/2026-07-29…   # any run directory
 */

import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as claude from './harness/claude.ts';
import * as codex from './harness/codex.ts';
import type { Row } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

const RENDER: Record<string, (events: unknown[] | undefined) => string> = {
  claude: claude.render,
  codex: codex.render,
};

/** What `results.json` holds, read defensively: older runs wrote fewer fields. */
interface StoredResult {
  ok: boolean;
  pass?: boolean;
  reason?: string;
  error?: string;
  facts?: Record<string, unknown>;
  dir: string;
  model?: string;
  requestedModel?: string;
  effort?: string;
  agentVersion?: string;
  arm: string;
  case: string;
  axis?: string;
  harness?: string;
  n?: number;
  judgeCostUsd?: number;
}

interface Results {
  options?: Record<string, unknown>;
  environment?: {
    harness?: string;
    requested?: string;
    effort?: string;
    resolved?: string;
    cli?: string;
  }[];
  judge?: string;
  progress?: {
    completed?: number;
    total?: number;
    running?: boolean;
    active?: {
      harness: string;
      requestedModel: string;
      effort?: string;
      arm: string;
      case: string;
      n: number;
    }[];
  };
  rows: Row[];
  results: StoredResult[];
}

/** A fenced block or the prose between two of them. */
interface Segment {
  type: 'text' | 'code';
  lang?: string;
  text: string;
}

/**
 * What a trial spent. Dollars only when the agent's CLI reported them — Claude
 * does, Codex does not — so tokens are carried too, and `raw` keeps whatever
 * was reported key for key, because the totals below are arithmetic somebody
 * may want to check.
 */
interface Usage {
  raw: Record<string, number>;
  input: number;
  output: number;
  total: number;
}

/** One thing the agent said or did, as the harness rendered it. */
interface Turn {
  kind: 'assistant' | 'tool' | 'result' | 'final' | 'thinking' | 'notice' | 'advice';
  label: string;
  segments: Segment[];
}

interface TrialView {
  id: string;
  case: string;
  axis: string;
  arm: string;
  harness: string;
  requestedModel: string;
  model: string;
  effort?: string;
  n: number;
  status: 'pass' | 'fail' | 'error';
  reason: string;
  facts: Record<string, unknown> | null;
  prompt: string;
  injected: string;
  rubric: string;
  answer: string;
  diff: string;
  transcript: Turn[];
  judgePrompt: string;
  judgeReply: string;
  cost: number | null;
  judgeCost: number | null;
  usage: Usage | null;
  turns: number | null;
  path: string;
}

interface Alert {
  level: 'error' | 'warn';
  title: string;
  body: string;
}

export function writePage(outDir: string): string {
  const target = join(outDir, 'report.html');
  const temporary = `${target}.next`;
  const data = collect(outDir);
  writeFileSync(temporary, page(data));
  renameSync(temporary, target);
  writeLiveData(outDir, data);
  return target;
}

function writeLiveData(outDir: string, data: ReturnType<typeof collect>): void {
  const target = join(outDir, 'report-data.js');
  const temporary = `${target}.next`;
  writeFileSync(temporary, `window.__updateEvaluatorReport?.(${json(data)});\n`);
  renameSync(temporary, target);
}

/**
 * Everything the page needs, in one object. The trial directories are the
 * source of truth for the long-form material; `results.json` only says which
 * trials there were and how each was scored.
 */
function collect(outDir: string) {
  const results = JSON.parse(readFileSync(join(outDir, 'results.json'), 'utf8')) as Results;
  const rows = results.rows ?? [];
  const trials = (results.results ?? []).map((result) => view(outDir, result, rows));

  // Arm order comes from the run's own options, because the baseline before
  // the plugin is the reading order of the comparison and alphabetical order
  // is not.
  const declared = (results.options?.arms ?? []) as { name?: string; kind?: string }[];
  const arms = [...new Set([...declared.map((a) => a.name), ...rows.map((r) => r.arm)])].filter(
    (name): name is string => Boolean(name),
  );

  const baseline = baselineArm(declared, arms);

  return {
    label: runLabel(outDir),
    dir: outDir,
    generated: new Date().toISOString(),
    options: results.options ?? {},
    environment: results.environment ?? [],
    judge: results.judge ?? null,
    progress: results.progress ?? {
      completed: trials.length,
      total: trials.length,
      running: false,
    },
    arms,
    baseline,
    rows,
    trials,
    alerts: results.progress?.running ? [] : alerts(rows, baseline),
  };
}

/**
 * Which arm injected nothing. Everything else on the page is read against it,
 * and runs from before the arms were renamed still say `none`, so the name is
 * found rather than assumed.
 */
function baselineArm(declared: { name?: string; kind?: string }[], arms: string[]): string | null {
  const found = declared.find((arm) => arm.kind === 'baseline' || arm.kind === 'none');
  return found?.name ?? arms.find((name) => name === 'baseline' || name === 'none') ?? null;
}

function view(outDir: string, result: StoredResult, rows: Row[]): TrialView {
  const id = basename(result.dir);
  // Runs get copied and moved around; the directory beside results.json is a
  // better bet than the absolute path recorded when the trial ran.
  const dir = existsSync(join(outDir, id)) ? join(outDir, id) : result.dir;
  const row = rows.find(
    (r) =>
      r.case === result.case &&
      r.arm === result.arm &&
      r.harness === result.harness &&
      r.requestedModel === result.requestedModel &&
      r.effort === result.effort,
  );

  const trial = sections(read(dir, 'trial.md') ?? '');
  const judgePrompt = read(dir, 'judge-prompt.md') ?? '';
  const judge = sections(judgePrompt);
  const harness = result.harness ?? row?.harness ?? 'claude';
  const events = eventsOf(dir);
  // What the model was handed, the advice included: Codex's rollout or Claude Code's session file.
  const rollout = eventsOf(dir, 'rollout.jsonl') ?? eventsOf(dir, 'session.jsonl');

  return {
    id,
    case: result.case,
    axis: result.axis ?? row?.axis ?? '',
    arm: result.arm,
    harness,
    requestedModel: result.requestedModel ?? row?.requestedModel ?? result.model ?? row?.model ?? '',
    model: result.model ?? row?.model ?? '',
    effort: result.effort ?? row?.effort,
    n: result.n ?? Number(/-(\d+)$/.exec(id)?.[1] ?? 0),
    status: !result.ok ? 'error' : result.pass ? 'pass' : 'fail',
    reason: (result.ok ? result.reason : result.error) ?? '',
    facts: result.facts ?? parse(read(dir, 'facts.json')),
    // The prompt is in both files; the judge's copy survives a trial that died
    // before any report was written.
    prompt: (trial.get('Prompt') ?? judge.get('The request the agent received') ?? '').trim(),
    injected: injectedContext(read(dir, 'injected.log') ?? ''),
    rubric: (judge.get('Rubric') ?? trial.get('Rubric applied') ?? '').trim(),
    answer: read(dir, 'answer.md') ?? '',
    diff: read(dir, 'changes.diff') ?? '',
    // The host's own record holds what the model was handed, the advice included; the event streams do not.
    transcript: turns(
      (rollout ?? events) ? RENDER[harness]?.((rollout ?? events) as unknown[]) ?? '' : (trial.get('Transcript') ?? ''),
    ),
    judgePrompt,
    judgeReply: read(dir, 'judge-reply.txt') ?? '',
    cost: number(events, 'total_cost_usd'),
    judgeCost:
      result.judgeCostUsd ?? (parse(read(dir, 'verdict.json'))?.costUsd as number | undefined) ?? null,
    usage: usageOf(events),
    turns: number(events, 'num_turns'),
    path: dir,
  };
}

/**
 * The warnings a run prints when it finishes, carried onto the page. A number
 * read without them can be read exactly backwards: a cell whose control failed
 * is not measuring the advice at all.
 */
function alerts(rows: Row[], baseline: string | null): Alert[] {
  const out: Alert[] = [];

  const brokenControls = rows.filter((r) => r.axis === 'control' && r.passed < r.ran);
  if (brokenControls.length > 0) {
    out.push({
      level: 'error',
      title: `Control failed in ${brokenControls.length} cell(s)`,
      body:
        'A control does not depend on any framing, so something in the pipeline is wrong: ' +
        'a harness that stopped injecting, a judge grading something other than what it was ' +
        'handed, an agent that never really ran. Every other number here is measuring that ' +
        `instead of the advice. Affected: ${brokenControls.map((r) => `${r.case} · ${r.arm}`).join(', ')}.`,
    });
  } else if (!rows.some((r) => r.axis === 'control')) {
    out.push({
      level: 'warn',
      title: 'No control case ran',
      body: 'Add --case control so a broken pipeline cannot pass for a result.',
    });
  }

  for (const row of rows.filter((r) => r.arm === baseline && r.axis !== 'control')) {
    if (row.ran > 0 && row.passed < row.ran) {
      out.push({
        level: 'warn',
        title: `Baseline unreliable — ${row.case} on ${row.harness}/${row.model}@${row.effort ?? 'default'}`,
        body:
          `${row.passed}/${row.ran} without the plugin. The base task is not being done even ` +
          'before any advice is injected, so the other arms for this case say nothing about the ' +
          `advice. Reason given: ${row.detail}`,
      });
    }
  }

  const empty = rows.filter((r) => r.ran === 0);
  if (empty.length > 0) {
    out.push({
      level: 'error',
      title: `${empty.length} cell(s) produced no usable trial`,
      body: `Those are not results: ${empty.map((r) => `${r.case} · ${r.arm}`).join(', ')}.`,
    });
  }

  return out;
}

/** `2026-07-29T14-54-54-562Z` reads as a timestamp again. */
function runLabel(outDir: string): string {
  const name = basename(resolve(outDir));
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(name);
  return match ? `${match[1]} ${match[2]}:${match[3]}:${match[4]} UTC` : name;
}

function read(dir: string, name: string): string | null {
  try {
    return readFileSync(join(dir, name), 'utf8');
  } catch {
    return null;
  }
}

function parse(text: string | null): Record<string, unknown> | null {
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function eventsOf(dir: string, file = 'transcript.jsonl'): unknown[] | null {
  const raw = read(dir, file);
  if (!raw) {
    return null;
  }
  const events = raw
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
  return events.length > 0 ? events : null;
}

/**
 * The tokens a trial used, from whichever harness reported them: Claude on its
 * `result` event, Codex on `turn.completed`. Both put them under a top-level
 * `usage`, so the last one wins rather than either name being hardcoded.
 *
 * The two count differently, and adding the wrong pair double counts:
 *
 * - Claude's `input_tokens` excludes the cache, so `cache_creation_input_tokens`
 *   and `cache_read_input_tokens` are separate counters and belong in the sum.
 * - Codex's `input_tokens` includes it. Its own telemetry emits
 *   `non_cached_input_tokens` beside `input_tokens` and `cached_input_tokens`,
 *   which only makes sense if cached is a subset — so adding it would count
 *   those tokens twice.
 *
 * Reasoning tokens are likewise a subset of `output_tokens` and are not added.
 * Anything not summed is still in `raw`.
 */
function usageOf(events: unknown[] | null): Usage | null {
  let reported: Record<string, number> | null = null;
  for (const event of events ?? []) {
    const usage = (event as { usage?: unknown }).usage;
    if (usage && typeof usage === 'object') {
      const numbers = Object.entries(usage).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number',
      );
      if (numbers.length > 0) {
        reported = Object.fromEntries(numbers);
      }
    }
  }
  if (!reported) {
    return null;
  }

  const at = (key: string) => reported[key] ?? 0;
  const input = at('input_tokens') + at('cache_creation_input_tokens') + at('cache_read_input_tokens');
  const output = at('output_tokens');

  return { raw: reported, input, output, total: input + output };
}

/** What the run cost, wherever the harness put it. */
function number(events: unknown[] | null, key: string): number | null {
  for (const event of events ?? []) {
    const value = (event as Record<string, unknown>)[key];
    if (typeof value === 'number') {
      return value;
    }
  }
  return null;
}

/** `## Heading` to its body, for the markdown files a trial leaves behind. */
function sections(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  let heading: string | null = null;
  let body: string[] = [];

  for (const line of markdown.split('\n')) {
    const match = /^## (.+)$/.exec(line);
    if (match) {
      if (heading) {
        out.set(heading, body.join('\n'));
      }
      heading = match[1]!.trim();
      body = [];
    } else if (heading) {
      body.push(line);
    }
  }
  if (heading) {
    out.set(heading, body.join('\n'));
  }
  return out;
}

/**
 * A rendered transcript back into turns. Both harnesses render to the same
 * small vocabulary of `### ` headings, so this stays harness-agnostic and the
 * page inherits whatever a harness learns to render next.
 */
function turns(markdown: string): Turn[] {
  if (!markdown.trim()) {
    return [];
  }

  const out: Turn[] = [];
  let current: { heading: string; body: string[] } | null = null;
  const push = () => {
    if (current) {
      out.push({ ...classify(current.heading), segments: segments(current.body.join('\n')) });
    }
  };

  for (const line of markdown.split('\n')) {
    const match = /^### (.+)$/.exec(line);
    if (match) {
      push();
      current = { heading: match[1]!.trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  push();

  return out;
}

function classify(heading: string): { kind: Turn['kind']; label: string } {
  const tool = /^tool: (.+)$/.exec(heading);
  if (tool) {
    return { kind: 'tool', label: tool[1]! };
  }
  if (heading.startsWith('command')) {
    return { kind: 'tool', label: heading };
  }
  if (heading === 'file change') {
    return { kind: 'tool', label: 'file change' };
  }
  if (heading === 'result') {
    return { kind: 'result', label: 'result' };
  }
  if (heading === 'final answer') {
    return { kind: 'final', label: 'final answer' };
  }
  if (heading === 'reasoning') {
    return { kind: 'thinking', label: 'reasoning' };
  }
  if (heading === 'notice') {
    return { kind: 'notice', label: 'notice' };
  }
  if (heading === 'injected advice') {
    return { kind: 'advice', label: 'injected advice' };
  }
  return { kind: 'assistant', label: heading };
}

function segments(body: string): Segment[] {
  const out: Segment[] = [];
  let code: { lang: string; lines: string[] } | null = null;
  let text: string[] = [];

  const flush = () => {
    const joined = text.join('\n').trim();
    if (joined) {
      out.push({ type: 'text', text: joined });
    }
    text = [];
  };

  for (const line of body.split('\n')) {
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence && !code) {
      flush();
      code = { lang: fence[1] ?? '', lines: [] };
    } else if (fence && code) {
      out.push({ type: 'code', lang: code.lang, text: code.lines.join('\n') });
      code = null;
    } else if (code) {
      code.lines.push(line);
    } else {
      text.push(line);
    }
  }
  if (code) {
    out.push({ type: 'code', lang: code.lang, text: code.lines.join('\n') });
  }
  flush();

  return out;
}

/**
 * The readable advice out of the hook's JSON envelope. The same unwrapping
 * `trial.md` does, kept here so the page can be regenerated for a run whose
 * report was never written.
 */
function injectedContext(log: string): string {
  return log
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return (
          (JSON.parse(line) as { hookSpecificOutput?: { additionalContext?: string } })
            .hookSpecificOutput?.additionalContext ?? line
        );
      } catch {
        return line;
      }
    })
    .join('\n\n---\n\n');
}

/**
 * The finished report remains one self-contained file with no network
 * dependency. A running report additionally reads the adjacent atomic data
 * snapshot; the embedded snapshot makes the final HTML portable on its own.
 */
function page(data: ReturnType<typeof collect>): string {
  const css = readFileSync(join(HERE, 'page.css'), 'utf8');
  // morphdom keeps scroll and focus while a running page refreshes. It is not a
  // dependency of this repository, so the page falls back to a plainer patch
  // when it is not installed.
  const morphdomFile = join(HERE, '..', '..', 'node_modules', 'morphdom', 'dist', 'morphdom-umd.min.js');
  const morphdom = existsSync(morphdomFile) ? readFileSync(morphdomFile, 'utf8') : '';
  const js = readFileSync(join(HERE, 'page.js'), 'utf8');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Framing evaluation · ${escape(data.label)}</title>
<style>
${css}
</style>
</head>
<body>
<div id="app"></div>
<script type="application/json" id="run-data">${json(data)}</script>
<script>
${morphdom}
${js}
</script>
</body>
</html>
`;
}

/** `</script>` inside a data island would end the island. */
function json(data: unknown): string {
  return JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028');
}

function escape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

// Run directly to rebuild the page for a run that has already finished.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const arg = process.argv[2];
  const dir = resolve(arg ?? join(HERE, '..', 'output', 'latest'));
  if (!existsSync(join(dir, 'results.json'))) {
    process.stderr.write(
      `no results.json in ${dir}\n` +
        `Usage: node lib/page.ts [output/<timestamp>]\n` +
        (existsSync(join(HERE, '..', 'output'))
          ? `Runs:\n  ${readdirSync(join(HERE, '..', 'output')).join('\n  ')}\n`
          : ''),
    );
    process.exit(2);
  }
  process.stdout.write(`${writePage(dir)}\n`);
}
