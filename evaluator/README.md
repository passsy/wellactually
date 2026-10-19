# Evaluator

Does the framing around injected advice move an agent the right way?

Everything else in this repository is testable the ordinary way: a detector either finds the enum on line 6 or it does not.
The words wrapped around that finding are not.
They only exist to move a language model, so the only honest way to check them is to move one and look.

This is not a test per principle.
It is a handful of handcrafted cases, each with a real principle, that ask whether the framing in `packages/cli/src/board/board.ts` makes advice land when it should and stay out of the way when it should not.

## Running it

```bash
node evaluator/run.ts --agent codex --judge-model codex:gpt-5.6-terra
```

```bash
node evaluator/run.ts --agent claude:sonnet --agent codex --case new-enum,control --n 5
```

`node evaluator/run.ts -h` lists every flag, the models each CLI offers and every case.
The judge defaults to Claude; prefix it with `codex:` to grade on Codex when Claude is signed out.
A run costs one agent run and one judge call per trial, paid by whoever is signed in to each CLI.

Everything lands in `evaluator/output/<timestamp>/`, gitignored, with `output/latest` pointing at the newest run.
The run opens its `report.html` as soon as it starts and refreshes it as trials finish: every cell side by side, each square one trial that opens its verdict, advice, diff and transcript.
`node evaluator/lib/page.ts <run>` rebuilds the page for a finished run.
Each trial keeps its host's own record of the session (`session.jsonl` for Claude Code, `rollout.jsonl` for Codex), the only place that shows where the advice was handed over; the report's transcript is built from it.
Start with a trial's `trial.md`: the prompt, the exact advice the hook handed over, the diff, the transcript, the facts and the judge's reply, in reading order.

## Arms

| arm | what the agent gets |
| --- | --- |
| `baseline` | no hooks, no MCP server: the floor |
| `plugin` | this working tree's hook with every event and matcher from `hooks/hooks.json`, and the plugin's MCP server |
| `framing:<file.ts>` | the same, with `frameEvents` from that module instead of the shipped one |

The framing arm is the reason this exists.
Copy `frameEvents` and its helpers out of `board.ts` into a file, change the words, and run both arms side by side before either ships:

```bash
node evaluator/run.ts --agent codex --arms baseline,plugin,framing:./quieter.ts
```

Only the words differ: the detectors, the principles and the session memory are the ones `plugin` uses.

## Every trial is isolated

Each trial gets a fresh fixture with its own git repository, and its own `WELLACTUALLY_HOME` holding an advisory board of just the case's principles.
Nothing on the machine it runs on may reach the agent:

- Claude runs with `--setting-sources project`, the installed wellactually plugin switched off in the fixture's settings, and `--strict-mcp-config`.
- Codex runs with a throwaway `CODEX_HOME`, plugins off, hooks and the MCP server written there, because a repo-local hooks file never fires.
- The registry in the trial's config is a stub this run starts, which accepts ratings into the trial's `ratings.jsonl` the way the real one would, so a rating never leaves the machine and the agent is not told it failed.
- The judge runs in an empty directory with every customization off.

## The three kinds

Advice injected too loudly hijacks the task, too quietly it never lands.
Every case asks one of three questions:

| kind | the task | passes when |
| --- | --- | --- |
| `action` | is the work the advice governs | the advice changes what the agent produces, and the user's request still gets done |
| `informative` | is a question about that subject | the answer is still the answer to what was asked |
| `control` | is unrelated to the advice | the output is what it would have been anyway |

Each trial is graded against the arm's half of the rubric.
The baseline is owed the base task only, since it never saw the advice; the plugin run is owed the base task and the advice, never the advice instead.

An `action` case needs a discriminator: something the baseline reliably does that the advice forbids.
The enum cases ask for a new file with an `OrderStatus` in a project that has no enum and no union of literals, so the agent follows no pattern and its choice is its own.
Where code already follows a pattern, continuing it is right whatever the advice says, so an earlier fixture full of enums measured nothing about the framing.
gpt-5.6-terra writes an enum here every time, gpt-6.1-sol sometimes and Opus 5.5 never; a model that writes the union on its own gets no advice, and its trial is an error rather than a pass.
The README cases use `passsy/write-markdown`, whose first rule every model breaks on a fresh README, so they measure Opus too.

## Cases

| case | measures | hosts |
| --- | --- | --- |
| `new-enum/action` | advice after a write lands in that write | both |
| `summary-only/action` | the one-sentence summary alone still changes the code | both |
| `delegated-enum/action` | advice reaches a subagent that does the writing | Claude |
| `readme/action` | advice after writing a README gets the prose to one sentence per line | both |
| `delegated-readme/action` | the same through a subagent | Claude |
| `commit-word/control` | a pointer from a word in the prompt changes nothing on a rename | both |

Every trial with advice is also held to the `quiet-about-ratings` check: the rating line says it needs no word to the user.

The principles in `evaluator/principles` are real ones from the registry, copied in with `wellactually pull`.
They are snapshots, so an expert editing their advice on the website never moves a number here.

There is no case for advice on a file the agent only read.
Both Claude Code and Codex read files through the shell (`cat`, `sed -n`), which reaches detectors as a command, not as a read, so `onRead` never fired in a trial.

## A trial that measured nothing is an error

An arm with advice that never ran its hook, or ran it and handed over nothing the case expected, is reported as `ERROR` and excluded from every count.
So is a trial a case declares unmeasured: `summary-only` fails a trial in which the full advice appeared after all.
"The framing had no effect" and "the framing never arrived" look the same in a transcript, and only one of them is about the framing.

A baseline that cannot do the task stops its plugin row being read, and a run without a control case says so.
Run `baseline` always: without the floor, a cell where every arm passes is indistinguishable from one where the advice did the work.

## Re-grading

Every trial stores its workspace, pristine copy, answer and `truth.json`, so grading can run again without the agents:

- `--rescore <run>` re-grades stored trials after a rubric, check or judge change.
- `--resume <run>` fills in the trials an interrupted run never finished.

## Adding a case

A case is `cases/<scenario>/<kind>.ts`, where kind is `action`, `informative` or `control`:

```ts
export const axis: Axis = 'action';
export const principles = ['passsy/prefer-union-over-enum']; // under evaluator/principles
export const prompt = 'In src/post.ts, add …';
export const timeoutMs = 180_000;
export const build = buildFixture;                    // writes the fixture, returns plain JSON truth
export const rubric = { baseline, withRule };
export function facts(trial, truth) {}                // observations, never verdicts
export function checks(trial, truth) {}               // named assertions, decided before the judge is paid
```

Optional: `harnesses` for a case that needs one host, `expectInjected` for text the advice must contain, `seen` for principles the session counts as already shown, and `unmeasured` for a premise beyond "it fired".

Put whatever code can see into `checks`, holding only the plugin arm to the advice with `trial.withAdvice`.
Leave the judge only what needs reading.
Before paying for a run, check with `wellactually try` that the prompt or the write fires the case's principle.
