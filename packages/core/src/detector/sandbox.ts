import { shouldInterruptAfterDeadline, type QuickJSWASMModule } from "quickjs-emscripten-core";
import { API_VERSION, type Ctx, type Finding } from "@wellactually/sdk";
import { environmentFor, unsupported, type Environment } from "./api.ts";
import { BUNDLE_GLOBAL, TESTS_GLOBAL } from "../build/bundle.ts";
import { loadSandbox } from "../build/engines.ts";
import { normalizeAbsolute, type ProjectFiles } from "./project.ts";

export interface Limits {
  /** Wall clock budget for one detector run. */
  ms: number;
  memoryBytes: number;
}

/** The limits every detector runs under: in the CLI, on the registry and in the hook. */
export const DEFAULT_LIMITS: Limits = {
  ms: 100,
  memoryBytes: 32 * 1024 * 1024,
};

export const MAX_FINDINGS = 20;
export const MAX_MATCH_LENGTH = 300;
/** How much of what a detector threw its author is shown. */
export const MAX_THROWN_LENGTH = 1000;

export interface DetectorRun {
  /** Findings that passed validation. */
  findings: Finding[];
  /**
   * Why the run produced nothing usable, or null when it completed.
   * The host wrote it, so it can be shown to an agent.
   */
  error: string | null;
  /**
   * What the detector threw, in its own words, when it threw. For its author
   * only: the detector chose this text, so it never goes in front of an agent.
   */
  thrown?: string;
  /** What the host left out of the findings, with the reason, for the author to read. */
  dropped: string[];
  ms: number;
}

const RUN = `JSON.stringify(${BUNDLE_GLOBAL}.run(JSON.parse(__ctx), ${MAX_FINDINGS}))`;

/**
 * The limits for loading a detector at build time. Nothing waits on a build
 * the way an agent waits on a hook, and builds run many at once in a test
 * suite, so the clock is generous. A run still gets `DEFAULT_LIMITS`.
 */
const LOAD_LIMITS: Limits = { ...DEFAULT_LIMITS, ms: 2000 };

const HANDLERS = `JSON.stringify(${BUNDLE_GLOBAL}.handlers())`;

/**
 * Reads which handlers a bundled detector registers: `onWrite` and the others, with their globs.
 *
 * The bundle is evaluated once, at build time. The result is unvalidated:
 * whatever the module registered.
 */
export async function readRegistered(bundle: string, limits: Limits = LOAD_LIMITS): Promise<unknown> {
  const { json, error, thrown } = evaluateIn(await loadSandbox(), `${bundle}\n;${HANDLERS}`, NOTHING, limits);
  if (json === null) {
    throw new Error(`detector.ts could not be loaded: ${forAuthor(error ?? "it returned nothing", thrown)}`);
  }
  return JSON.parse(json) as unknown;
}

/** An isolate with nothing in it but the script. */
const NOTHING: Environment = { strings: {}, functions: {} };

/**
 * Evaluates a script in a fresh isolate and returns the string it ends with.
 * The WebAssembly module is loaded already, so an isolate starts and ends without waiting.
 */
function evaluateIn(QuickJS: QuickJSWASMModule, script: string, environment: Environment, limits: Limits): { json: string | null } & Failure {
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + limits.ms));
  const vm = runtime.newContext();

  let json: string | null = null;
  let failure: Failure = { error: null };
  try {
    for (const [name, value] of Object.entries(environment.strings)) {
      const handle = vm.newString(value);
      vm.setProp(vm.global, name, handle);
      handle.dispose();
    }
    for (const [name, implementation] of Object.entries(environment.functions)) {
      const handle = vm.newFunction(name, (argument) => vm.newString(implementation(vm.getString(argument))));
      vm.setProp(vm.global, name, handle);
      handle.dispose();
    }
    const result = vm.evalCode(script, "detector.js");
    if (result.error) {
      const dumped: unknown = vm.dump(result.error);
      // Dumping a promise disposes of it already.
      if (result.error.alive) {
        result.error.dispose();
      }
      failure = describeError(dumped, limits);
    } else {
      json = vm.getString(result.value);
      result.value.dispose();
    }
  } catch (thrown) {
    failure = describeError(thrown, limits);
  } finally {
    try {
      vm.dispose();
      runtime.dispose();
    } catch (thrown) {
      // The engine refused to let go of the isolate, after what the script did. Its result is not to be trusted.
      json = null;
      if (failure.error === null) {
        failure = describeError(thrown, limits);
      }
    }
  }
  return { json, ...failure };
}

/**
 * Runs one bundled detector against one context inside a fresh isolate.
 *
 * The isolate gets the context as a JSON string and hands back a JSON string.
 * It has no network and no process. The one thing it can ask the host for is
 * a file from `project`, and only to read it. Without one it sees the event
 * and no files. A detector that runs out of time or memory ends with an
 * error, never with a hung hook.
 *
 * `api` is the detector API version the bundle was built against, from its
 * manifest. The detector gets the event and the host functions of that
 * version, whatever today's are.
 */
export async function runDetector(
  bundle: string,
  ctx: Ctx,
  limits: Limits = DEFAULT_LIMITS,
  project: ProjectFiles | null = null,
  api: number = API_VERSION,
): Promise<DetectorRun> {
  return runDetectorIn(await loadSandbox(), bundle, ctx, limits, project, api);
}

/** `runDetector` without the wait, for callers that have to answer at once: a test's `detect()`. */
export async function detectorRunner(): Promise<(bundle: string, ctx: Ctx, project: ProjectFiles | null, api?: number) => DetectorRun> {
  const QuickJS = await loadSandbox();
  return (bundle, ctx, project, api = API_VERSION) => runDetectorIn(QuickJS, bundle, ctx, DEFAULT_LIMITS, project, api);
}

function runDetectorIn(QuickJS: QuickJSWASMModule, bundle: string, ctx: Ctx, limits: Limits, project: ProjectFiles | null, api: number): DetectorRun {
  const refused = unsupported(api);
  if (refused !== null) {
    return { findings: [], error: refused, dropped: [], ms: 0 };
  }
  const started = performance.now();
  // Whatever a detector does, the host answers with a run: one detector must never take the others down with it.
  try {
    const { json, error, thrown } = evaluateIn(QuickJS, `${bundle}\n;${RUN}`, environmentFor(api, ctx, project), limits);
    const ms = performance.now() - started;
    if (json === null) {
      return { findings: [], error: error ?? "the detector returned nothing", ...(thrown === undefined ? {} : { thrown }), dropped: [], ms };
    }
    const { findings, dropped } = validateFindings(json, ctx, project);
    return { findings, error: null, dropped, ms };
  } catch {
    return { findings: [], error: "the host could not make sense of what the detector did", dropped: [], ms: performance.now() - started };
  }
}

/** The limits a principle's whole test run gets. Each detector run inside it still gets `DEFAULT_LIMITS`. */
export const TEST_LIMITS: Limits = {
  ms: 5000,
  memoryBytes: 64 * 1024 * 1024,
};

/** What the test runner asks of whoever runs it. */
export interface TestHost {
  /** A test is about to start. Detector runs that follow belong to it. */
  begin: (test: { file: string; name: string }) => void;
  /** A test called `detect(event, options)`. `run` runs a bundled detector in a fresh isolate, right now. */
  detect: (call: unknown, run: (bundle: string, ctx: Ctx, project: ProjectFiles | null, api: number) => DetectorRun) => { findings: Finding[] } | { error: string };
}

export interface RawTestResult {
  file: string;
  name: string;
  passed: boolean;
  /** Why it failed. Empty when it passed. */
  message: string;
}

/**
 * Runs a principle's bundled tests inside an isolate.
 *
 * The tests are the author's code, so they get less than a detector gets: no
 * files, no network, no process. The one thing they can reach is
 * `detect`, which is answered by `host`, outside the isolate. That is how the
 * registry learns what the tests actually exercised, instead of taking a
 * test's word for it.
 */
export async function runTestBundle(bundle: string, host: TestHost, limits: Limits = TEST_LIMITS): Promise<{ results: RawTestResult[]; error: string | null }> {
  const QuickJS = await loadSandbox();
  const run = (detector: string, ctx: Ctx, project: ProjectFiles | null, api: number): DetectorRun => runDetectorIn(QuickJS, detector, ctx, DEFAULT_LIMITS, project, api);
  const functions: Environment["functions"] = {
    __begin: (test) => {
      host.begin(JSON.parse(test) as { file: string; name: string });
      return "";
    },
    __detect: (call) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(call);
      } catch {
        return JSON.stringify({ error: "detect() was not given an event" });
      }
      return JSON.stringify(host.detect(parsed, run));
    },
  };
  const { json, error, thrown } = evaluateIn(QuickJS, `${bundle}\n;${TESTS_GLOBAL}.run()`, { strings: {}, functions }, limits);
  if (json === null) {
    // The tests are the author's, and so is what they threw.
    return { results: [], error: forAuthor(error ?? "the tests returned nothing", thrown).replace("the detector ran longer", "the tests ran longer").replace("the detector used more", "the tests used more") };
  }
  return { results: JSON.parse(json) as RawTestResult[], error: null };
}

/**
 * A value the script handed over, as JSON. It came out of the isolate as
 * JSON, so it may be an object whose `toString` is anything, including
 * missing, and `String()` would throw on it.
 */
function jsonOf(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "a value that is not text";
  }
}

/** A message the script threw, as text. */
function textOf(value: unknown): string {
  return typeof value === "string" ? value : jsonOf(value);
}

/** A value of a finding the host left out, short enough to quote back to the author. */
function quoted(value: unknown): string {
  const text = jsonOf(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** Why an isolate ended without a result: what the host says, and what the script threw. */
interface Failure {
  error: string | null;
  thrown?: string;
}

/** Why a run failed, for the author of the detector: what it threw, or else what the host says. Never for an agent. */
export function forAuthor(error: string, thrown: string | undefined): string {
  return thrown ?? error;
}

/**
 * Splits why an isolate ended into what the host can say about it and what
 * the script said. Running out of time or memory is the host's own finding.
 * Anything else the script threw, and its message is the script's text: a
 * detector could put a file it read there, or words for the agent.
 */
function describeError(dumped: unknown, limits: Limits): Failure {
  const message = typeof dumped === "object" && dumped !== null && "message" in dumped ? textOf((dumped as { message: unknown }).message) : textOf(dumped);
  if (message.includes("interrupted")) {
    return { error: `the detector ran longer than ${limits.ms} ms and was stopped` };
  }
  if (message.includes("out of memory")) {
    return { error: `the detector used more than ${limits.memoryBytes / 1024 / 1024} MB and was stopped` };
  }
  const name =
    typeof dumped === "object" && dumped !== null && "name" in dumped ? `${textOf((dumped as { name: unknown }).name)}: ` : "";
  const thrown = `${name}${message}`;
  return { error: "the detector threw an error", thrown: thrown.length > MAX_THROWN_LENGTH ? `${thrown.slice(0, MAX_THROWN_LENGTH)}…` : thrown };
}

/** A path as the agent is shown it: from the project root when it lies inside the project. */
function fromRoot(file: string, root: string | null): string {
  if (root !== null && file.startsWith(`${root}/`)) {
    return file.slice(root.length + 1);
  }
  return file;
}

/**
 * The path of a finding's `file` as the agent is shown it, when the file or
 * folder exists. Null when it does not, or when there are no files to ask.
 * A relative path is from the project root, or from where the session runs
 * when there is none.
 */
function existingFile(file: string, ctx: Ctx, project: ProjectFiles | null): string | null {
  const base = ctx.project ?? ctx.cwd ?? "/";
  const absolute = normalizeAbsolute(file.startsWith("/") ? file : `${base}/${file}`);
  // The file of the event is there: it was just written or read.
  const exists = absolute === ctx.file?.path || (project !== null && project.stat(absolute) !== null);
  return exists ? fromRoot(absolute, ctx.project) : null;
}

/** Whether every line from `first` to `last` has a text. */
function everyLine(first: number, last: number, textOn: (line: number) => string | undefined): boolean {
  for (let line = first; line <= last; line++) {
    if (textOn(line) === undefined) {
      return false;
    }
  }
  return true;
}

/** The texts of the lines from `first` to `last`. */
function linesFrom(first: number, last: number, textOn: (line: number) => string | undefined): string[] {
  const texts: string[] = [];
  for (let line = first; line <= last; line++) {
    texts.push(textOn(line) ?? "");
  }
  return texts;
}

/** Whether the event's text has lines a finding can point at: a file, or what a command printed. */
function hasLines(ctx: Ctx): boolean {
  return ctx.file !== null || ctx.event === "output";
}

/**
 * Keeps what a host can trust of the findings a detector reported.
 *
 * A finding says where, and the host quotes the place. The pieces of text a
 * detector hands over are `match` and `file`, and both end up in the agent's
 * context. A match must be a verbatim piece of what the detector was shown,
 * and a file must be one that exists or a verbatim piece of the event. That
 * keeps a detector from composing text of its own at runtime: the only words
 * it can put in front of an agent are words that were already there.
 *
 * A finding is never thrown away for a wrong detail. The detail is left out,
 * the finding still fires, and `dropped` says what happened. A test fails on
 * anything in `dropped`, so an author hears about it before a user does.
 */
export function validateFindings(json: string, ctx: Ctx, project: ProjectFiles | null = null): { findings: Finding[]; dropped: string[] } {
  const findings: Finding[] = [];
  const dropped: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { findings, dropped: ["the detector did not return JSON"] };
  }
  if (!Array.isArray(parsed)) {
    return { findings, dropped: ["the detector did not return a list of findings"] };
  }

  const lines = ctx.file?.lines ?? ctx.text.split("\n");
  const removed = new Map((ctx.file?.removed ?? []).map((line) => [line.line, line.text]));
  for (const raw of parsed) {
    if (findings.length >= MAX_FINDINGS) {
      dropped.push(`more than ${MAX_FINDINGS} findings; the rest were dropped`);
      break;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      dropped.push("a finding that is not an object");
      continue;
    }
    const candidate = raw as Record<string, unknown>;
    const finding: Finding = {};

    // A finding on removed lines counts lines in the file as it was, and only the removed ones are known.
    const onRemoved = candidate.removed === true;
    if (candidate.removed !== undefined && typeof candidate.removed !== "boolean") {
      dropped.push(`the removed of a finding, which is true or false: ${quoted(candidate.removed)}`);
    } else if (onRemoved && candidate.line === undefined) {
      dropped.push("the removed of a finding without a line");
    }
    const textOn = (line: number): string | undefined => {
      if (onRemoved) {
        return removed.get(line);
      }
      return lines[line - 1];
    };
    if (candidate.line !== undefined) {
      const line = candidate.line;
      if (!hasLines(ctx)) {
        dropped.push(`the line of a finding on a ${ctx.event}, which has no lines to point at`);
      } else if (typeof line !== "number" || !Number.isInteger(line) || textOn(line) === undefined) {
        if (onRemoved) {
          dropped.push(`line ${quoted(line)} of a finding, which the agent did not remove`);
        } else {
          dropped.push(`line ${quoted(line)} of a finding, which the ${ctx.file ? "file" : "output"} does not have`);
        }
      } else {
        finding.line = line;
        if (onRemoved) {
          finding.removed = true;
        }
      }
    }
    if (candidate.endLine !== undefined) {
      const endLine = candidate.endLine;
      if (finding.line === undefined) {
        dropped.push("the endLine of a finding without a line");
      } else if (typeof endLine !== "number" || !Number.isInteger(endLine) || endLine < finding.line || !everyLine(finding.line, endLine, textOn)) {
        dropped.push(`endLine ${quoted(endLine)} of a finding on line ${finding.line}`);
      } else if (endLine > finding.line) {
        finding.endLine = endLine;
      }
    }
    if (candidate.match !== undefined) {
      const match = typeof candidate.match === "string" ? candidate.match.trim() : "";
      // With a line the match has to be there, because that is where the agent is sent to look.
      const scope = finding.line === undefined ? [ctx.text, ...removed.values()] : linesFrom(finding.line, finding.endLine ?? finding.line, textOn);
      if (match === "") {
        dropped.push("an empty match");
      } else if (match.includes("\n")) {
        dropped.push(`a match that spans lines: ${JSON.stringify(match.slice(0, 60))}. Name the lines with line and endLine.`);
      } else if (match.length > MAX_MATCH_LENGTH) {
        dropped.push(`a match longer than ${MAX_MATCH_LENGTH} characters`);
      } else if (!scope.some((text) => text.includes(match))) {
        dropped.push(`a match that does not occur ${finding.line === undefined ? "in the input" : finding.endLine === undefined ? `on line ${finding.line}` : `in lines ${finding.line} to ${finding.endLine}`}: ${JSON.stringify(match.slice(0, 60))}`);
      } else {
        finding.match = match;
      }
    }
    if (candidate.file !== undefined) {
      const file = typeof candidate.file === "string" ? candidate.file.trim() : "";
      if (file === "") {
        dropped.push("the file of a finding, which is not a path");
      } else if (file.includes("\n")) {
        dropped.push("the file of a finding, which spans lines");
      } else if (file.length > MAX_MATCH_LENGTH) {
        dropped.push(`the file of a finding, a path longer than ${MAX_MATCH_LENGTH} characters`);
      } else {
        const shown = existingFile(file, ctx, project);
        if (shown !== null) {
          finding.file = shown;
        } else if (ctx.text.includes(file)) {
          // A path the event names, such as the output file of a command about to run, may not exist yet.
          finding.file = fromRoot(file, ctx.project);
        } else {
          dropped.push(`the file of a finding, which does not exist and does not occur in the input: ${JSON.stringify(file.slice(0, 60))}`);
        }
      }
    }
    if (candidate.depth !== undefined) {
      if (candidate.depth !== "pointer" && candidate.depth !== "full") {
        dropped.push(`the unknown depth ${quoted(candidate.depth)}`);
      } else {
        finding.depth = candidate.depth;
      }
    }
    findings.push(finding);
  }
  return { findings, dropped };
}
