/**
 * The scorer: everything after the agent has run.
 *
 * Scoring works entirely from what a trial directory holds — the workspace,
 * the pristine copy, `answer.md`, `truth.json` — so it can run twice: once
 * right after the agent, and again later when a rubric, a check, or the judge
 * changed. Re-grading a stored run costs a judge call, not an agent run.
 *
 * Two layers, cheapest first, the way assertion-composing frameworks order
 * them:
 *
 * 1. `checks` — deterministic assertions the case makes in code. A failing
 *    check fails the trial without a model call, and its name is the reason.
 * 2. the judge — a pinned model grading against the arm's rubric, for the
 *    half of the question only reading can answer.
 *
 * `facts` stays what it always was: observations handed to the judge, never
 * verdicts. Checks are recorded beside them so a verdict is arguable against
 * everything that produced it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { diffTree } from './diff.ts';
import { judge } from './judge.ts';
import type {
  Arm,
  Case,
  Check,
  Facts,
  Harness,
  Outcome,
  Truth,
  Verdict,
} from './types.ts';

export interface ScoreRequest {
  testCase: Case;
  arm: Arm;
  runDir: string;
  judgeModel: string;
  /** Fresh runs pass the outcome through; a re-score reads the stored files. */
  outcome?: Extract<Outcome, { ok: true }>;
}

export type Scored =
  | { ok: false; error: string }
  | {
      ok: true;
      pass: boolean;
      reason: string;
      facts: Facts;
      checks: Check[];
      judgeCostUsd?: number;
      rubric: string;
      patch: string;
      verdictRaw?: string;
    };

export async function score({
  testCase,
  arm,
  runDir,
  judgeModel,
  outcome,
}: ScoreRequest): Promise<Scored> {
  const dir = join(runDir, 'workspace');
  const truth = JSON.parse(readFileSync(join(runDir, 'truth.json'), 'utf8')) as Truth;
  const text = outcome?.text ?? readFileSync(join(runDir, 'answer.md'), 'utf8');

  const { edited, patch } = diffTree(runDir);
  if (patch.trim()) {
    writeFileSync(join(runDir, 'changes.diff'), patch);
  }

  const withAdvice = arm.kind !== 'baseline';
  const trial = { text, dir, runDir, edited, withAdvice };
  const observed = testCase.facts(trial, truth);
  const checks = [...(testCase.checks?.(trial, truth) ?? []), ...(withAdvice ? [quietAboutRatings(text)] : [])];

  // Checks travel with the facts: the judge sees what the case already
  // verified mechanically, and the stored file shows both halves of the
  // verdict's evidence.
  const facts: Facts =
    checks.length > 0
      ? {
          ...observed,
          checks: checks.map(({ name, pass, evidence }) => ({ name, pass, evidence })),
        }
      : observed;
  writeFileSync(join(runDir, 'facts.json'), `${JSON.stringify(facts, null, 2)}\n`);

  // The two arms are graded against different bars. Without the plugin only
  // the base task is owed; the rule's effect is not something the agent could
  // have known about. Holding both arms to the same rubric would score the
  // floor as a failure and make every case look like the plugin was load
  // bearing when it was only the difference between two rubrics.
  const ruleInjected = withAdvice;
  const rubric =
    typeof testCase.rubric === 'string'
      ? testCase.rubric
      : ruleInjected
        ? testCase.rubric.withRule
        : testCase.rubric.baseline;

  const failed = checks.filter((check) => !check.pass);
  if (failed.length > 0) {
    // Code already decided; paying a judge to notice the same thing would only
    // add a way for the verdict to be wrong.
    const reason = `check failed: ${failed.map((check) => check.name).join(', ')}`;
    writeVerdict(runDir, { pass: false, reason });
    return {
      ok: true,
      pass: false,
      reason,
      facts,
      checks,
      rubric,
      patch,
    };
  }

  const verdict = await judge({
    rubric,
    request: testCase.prompt,
    answer: text,
    facts,
    ruleInjected,
    model: judgeModel,
  });

  // A judge that could not answer has not found a failing trial, it has failed
  // to grade one. Scoring that as a fail would quietly count grading outages
  // against whichever arm was unlucky.
  writeFileSync(join(runDir, 'judge-prompt.md'), verdict.prompt ?? '');
  if (verdict.raw !== undefined) {
    writeFileSync(join(runDir, 'judge-reply.txt'), verdict.raw);
  }

  if (!verdict.ok) {
    return { ok: false, error: verdict.error };
  }

  writeVerdict(runDir, {
    pass: verdict.pass,
    reason: verdict.reason,
    costUsd: verdict.costUsd,
  });

  return {
    ok: true,
    pass: verdict.pass,
    reason: verdict.reason,
    facts,
    checks,
    judgeCostUsd: verdict.costUsd,
    rubric,
    patch,
    verdictRaw: verdict.raw,
  };
}

function writeVerdict(
  runDir: string,
  verdict: { pass: boolean; reason: string; costUsd?: number },
): void {
  writeFileSync(join(runDir, 'verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`);
}

/**
 * One file per trial holding the whole story in reading order: what was asked,
 * what was injected, everything the agent did, what the harness observed, and
 * how the judge ruled. When a verdict looks wrong this is the file to open.
 */
export interface TrialReportInput {
  harness: Harness;
  model: string;
  effort?: string;
  testCase: Case;
  arm: Arm;
  n: number;
  judgeModel: string;
  scored: Extract<Scored, { ok: true }>;
  runDir: string;
  /** From the outcome on a fresh run, from trial.json on a re-score. */
  answeredBy?: string;
  agentVersion?: string;
  /** The live event stream, when the agent just ran. */
  events?: unknown[];
}

export function writeTrialReport({
  harness,
  model,
  effort,
  testCase,
  arm,
  n,
  judgeModel,
  scored,
  runDir,
  answeredBy,
  agentVersion,
  events,
}: TrialReportInput): void {
  const injected = readIfPresent(join(runDir, 'injected.log'));
  const transcript = renderedTranscript(harness, runDir, events);

  const report = [
    `# ${testCase.id} · ${arm.name} · ${harness.id}/${answeredBy ?? model} · effort ${effort ?? 'CLI default'} · trial ${n}`,
    '',
    `**${scored.pass ? 'PASS' : 'FAIL'}** — ${scored.reason}`,
    '',
    [
      `Ran on \`${harness.id}\`${agentVersion ? ` ${agentVersion}` : ''}`,
      answeredBy && answeredBy !== model
        ? `asked for \`${model}\`, answered by \`${answeredBy}\``
        : `model \`${model}\``,
      `effort \`${effort ?? 'CLI default'}\``,
      `judged by \`${judgeModel}\``,
    ].join(' · '),
    '',
    '## Prompt',
    '',
    testCase.prompt,
    '',
    '## Injected into the agent',
    '',
    arm.kind === 'baseline'
      ? '_Nothing. This is the baseline arm._'
      : injected
        ? `\`\`\`\n${injectedContext(injected)}\n\`\`\``
        : '_The hook ran but no rule fired._',
    '',
    '## What changed on disk',
    '',
    scored.patch.trim()
      ? `\`\`\`diff\n${clip(scored.patch)}\n\`\`\``
      : '_The agent left the fixture exactly as it found it._',
    '',
    '## Transcript',
    '',
    transcript,
    '',
    ...(scored.checks.length > 0
      ? [
          '## Deterministic checks',
          '',
          ...scored.checks.map(
            (check) =>
              `- ${check.pass ? 'pass' : '**FAIL**'} \`${check.name}\`${check.evidence ? ` — ${check.evidence}` : ''}`,
          ),
          '',
        ]
      : []),
    '## Facts given to the judge',
    '',
    `\`\`\`json\n${JSON.stringify(scored.facts, null, 2)}\n\`\`\``,
    '',
    '## Rubric applied',
    '',
    scored.rubric.trim(),
    '',
    '## Judge reply',
    '',
    scored.verdictRaw !== undefined
      ? `\`\`\`\n${scored.verdictRaw}\n\`\`\``
      : '_No judge ran: a deterministic check already decided this trial._',
    '',
    '---',
    '',
    'Beside this file: `workspace/` as the agent left it, `pristine/` as it was built, ' +
      'and the full `changes.diff`, `transcript.jsonl`, `judge-prompt.md`, `judge-reply.txt`, ' +
      '`injected.log`, `facts.json`, `truth.json`, `trial.json`.',
  ].join('\n');

  writeFileSync(join(runDir, 'trial.md'), report);
}

/**
 * A re-score has no live event stream, so the harness renders from the stored
 * transcript when it can, and the report says where to look otherwise.
 */
function renderedTranscript(
  harness: Harness,
  runDir: string,
  events?: unknown[],
): string {
  if (typeof harness.render !== 'function') {
    return '_This harness does not render transcripts; see transcript.jsonl._';
  }
  // The host's own record holds what the model was handed, the advice included; the event streams do not.
  const rollout = readIfPresent(join(runDir, 'rollout.jsonl')) ?? readIfPresent(join(runDir, 'session.jsonl'));
  if (events && rollout === null) {
    return harness.render(events);
  }
  const raw = rollout ?? readIfPresent(join(runDir, 'transcript.jsonl'));
  if (raw === null) {
    return '_No transcript was recorded._';
  }
  const parsed = raw
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
  return harness.render(parsed);
}

/** A diff of a rewritten file can run for pages; changes.diff holds all of it. */
function clip(value: string, limit = 8000): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n… [${value.length - limit} more characters, see changes.diff]`;
}

/** Pull the readable advice out of the hook's JSON envelope. */
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

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Every injection ends with a line inviting a rating and saying to leave it
 * out of the answer. An answer that talks about rating anyway was moved by framing
 * nobody asked about, whatever the case is measuring.
 */
function quietAboutRatings(text: string): Check {
  const said = /rate_principle|\brat(?:e|ing)s?\b[^.\n]{0,40}\b(?:principle|advice|expert)/i.exec(text);
  return { name: 'quiet-about-ratings', pass: said === null, evidence: said?.[0] };
}
