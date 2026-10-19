/**
 * The shapes the evaluator is built from.
 *
 * Three of them carry the discipline the whole thing depends on. A `Case`
 * returns `facts`, never a verdict. A `Rubric` has two halves because the
 * baseline and the plugin run are owed different things. An `Outcome` is a
 * union, so a trial that failed to run cannot be read as a trial that produced
 * a bad answer without the compiler objecting.
 */

export type Axis = 'action' | 'informative' | 'control';

/**
 * Where a trial's framing came from: nowhere, the plugin in this working
 * tree, or a candidate module. One axis, so two arms of the same run can be read against
 * each other without asking what either name is measuring.
 */
export type ArmKind = 'baseline' | 'plugin' | 'framing';

export interface Arm {
  name: string;
  kind: ArmKind;
  /** Only for `framing` arms: the module exporting `frameEvents`. */
  path?: string;
}

export interface HookSpec {
  event: string;
  matcher?: string;
  command: string;
}

export interface McpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface Injection {
  /** Null when the arm injects nothing. */
  hooks: HookSpec[] | null;
  /** The plugin's MCP server, null for the baseline, which has no plugin. */
  mcp: McpServer | null;
  /** The trial's WELLACTUALLY_HOME. */
  home: string;
}

/**
 * Whatever a case's `build` learned while writing the fixture, handed back to
 * `facts` afterwards. Each case decides its own shape.
 */
export type Truth = Record<string, unknown>;

/** Objective observations, never judgements. */
export type Facts = Record<string, unknown>;

export interface Rubric {
  /** Graded without the plugin: the base task and nothing else. */
  baseline: string;
  /** Graded with the plugin: the base task and the advice. */
  withRule: string;
}

/** What `facts` is given: the finished run plus where it happened. */
export interface ScoredTrial {
  text: string;
  /** The workspace the agent worked in. */
  dir: string;
  /** The trial directory, with transcript.jsonl and injected.log. */
  runDir: string;
  edited: boolean;
  /** Whether this arm installed the hook, so a check can hold only it to the advice. */
  withAdvice: boolean;
}

/**
 * One deterministic assertion a case makes about a finished trial.
 *
 * A check is code looking at the artifact, so it cannot be argued with the way
 * a judge can. A failed check fails the trial before the judge is ever paid,
 * and its name shows up in the verdict so the failure reads as "retry-count
 * kept" rather than a sentence of prose.
 */
export interface Check {
  name: string;
  pass: boolean;
  /** What the check saw, quoted for the trial report. */
  evidence?: string;
}

export interface Case {
  /** Derived from the file path, not declared. */
  id: string;
  axis: Axis;
  /**
   * The advisory board of the trial, as `expert/slug` ids of directories under
   * evaluator/principles. Fixed principles, so an expert editing their advice
   * on the website never moves a number here.
   */
  principles: string[];
  /**
   * Text that must appear in what the hook handed the agent, so a trial whose
   * principle never fired, or fired as the wrong one, is an error rather than
   * a result. Defaults to the first principle's id.
   */
  expectInjected?: string[];
  /**
   * Principles whose full advice the session counts as already shown, so the
   * first time one fires it is only its summary.
   */
  seen?: string[];
  /**
   * Why a trial with advice measured nothing this case is about, or null when
   * it did. For a case whose premise needs more than "it fired", such as the
   * summary arriving on a second call: a trial without that is an error, not a pass.
   */
  unmeasured?: (runDir: string) => string | null;
  /**
   * Harnesses that can faithfully execute this scenario.
   *
   * Omitted means every harness. Use this only for a host capability the case
   * fundamentally depends on, such as Claude's hookable Task tool.
   */
  harnesses?: string[];
  /**
   * Override the agent sandbox for fixtures that need capabilities excluded
   * from the safe default. Git commit cases need to write `.git/index.lock`.
   */
  sandbox?: 'workspace-write' | 'danger-full-access';
  /**
   * Tools the agent may not use, for a case where using them measures the
   * environment rather than the rule. Honoured by the Claude harness; Codex
   * drives everything through its shell, so it has no equivalent.
   */
  disallowedTools?: string[];
  prompt: string;
  /** Maximum time the agent may spend on one trial of this case. */
  timeoutMs: number;
  build: (dir: string) => Truth;
  rubric: Rubric | string;
  facts: (trial: ScoredTrial, truth: Truth) => Facts;
  /**
   * Deterministic assertions, graded before the judge. Any failing check fails
   * the trial without a model call, so put the mechanically decidable half of
   * the rubric here — "the retry survived", "no commit was made" — and leave
   * the judge only what needs reading.
   */
  checks?: (trial: ScoredTrial, truth: Truth) => Check[];
}

export type Outcome =
  | { ok: false; error: string; transcript?: string }
  | {
      ok: true;
      text: string;
      turns?: number;
      costUsd?: number;
      transcript?: string;
      events?: unknown[];
      /**
       * What actually served the request, as the CLI reported it — not the
       * alias that was asked for. `sonnet` means a different model this month
       * than it will next month, so a result recorded under the alias cannot be
       * compared against a later one.
       */
      model?: string;
      /** The agent CLI's own version; harness behaviour is pinned to it. */
      agentVersion?: string;
    };

export interface RunRequest {
  dir: string;
  runDir: string;
  prompt: string;
  model: string;
  /** Omitted to let the selected agent CLI use its own default. */
  effort?: string;
  timeoutMs: number;
  /** Defaults to workspace-write. */
  sandbox?: 'workspace-write' | 'danger-full-access';
  /** See Case.disallowedTools. */
  disallowedTools?: string[];
}

/**
 * What the model segment of `--agent` will accept, for `--help`.
 * Grouped because the groups are not equally trustworthy: a vendor's own
 * inventory, an alias that resolves later, and "ids seen on this machine"
 * answer different questions, and collapsing them into one list would hide
 * which is which.
 */
export interface ModelGroup {
  ids: string[];
  /** Where this came from, so a stale or guessed list cannot pass for fact. */
  source: string;
}

export interface Harness {
  id: string;
  defaultModel: string;
  /** Optional: what this harness can be pointed at. */
  models?: () => ModelGroup[];
  prepare: (dir: string, injection: Injection, runDir: string) => void;
  run: (request: RunRequest) => Promise<Outcome>;
  /** Optional: turn the raw event stream into something readable. */
  render?: (events: unknown[] | undefined) => string;
  /**
   * Optional: drop whatever the harness needed only while the agent was
   * running. Trial directories are kept for reading, so anything a harness
   * leaves behind is published to whoever looks.
   */
  cleanup?: (runDir: string) => void;
}

export type Verdict =
  | { ok: false; error: string; prompt?: string; raw?: string }
  | {
      ok: true;
      pass: boolean;
      reason: string;
      prompt: string;
      raw: string;
      /** What grading cost, when the judge's CLI reported it. */
      costUsd?: number;
    };

export interface Row {
  harness: string;
  /** The CLI argument, retained when `model` is a resolved alias. */
  requestedModel?: string;
  model: string;
  effort?: string;
  case: string;
  axis: Axis;
  arm: string;
  ran: number;
  passed: number;
  errors: number;
  detail: string;
}
