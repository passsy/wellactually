import { shouldInterruptAfterDeadline } from "quickjs-emscripten-core";
import type { Ctx, Finding } from "@wellactually/sdk";
import { BUNDLE_GLOBAL } from "./bundle.ts";
import { loadSandbox } from "./engines.ts";

export interface Limits {
  /** Wall clock budget for one detector run. */
  ms: number;
  memoryBytes: number;
}

/** The limits every detector runs under: in the CLI, on the registry and in the hook. */
export const DEFAULT_LIMITS: Limits = {
  ms: 50,
  memoryBytes: 32 * 1024 * 1024,
};

export const MAX_FINDINGS = 20;
export const MAX_EVIDENCE_LENGTH = 300;

export interface DetectorRun {
  /** Findings that passed validation. */
  findings: Finding[];
  /** Why the run produced nothing usable, or null when it completed. */
  error: string | null;
  /** Findings the host dropped, with the reason, for the author to read. */
  dropped: string[];
  ms: number;
}

const RUN = `
(function () {
  const out = [];
  const found = ${BUNDLE_GLOBAL}.detect(JSON.parse(__ctx));
  if (found) {
    for (const finding of found) {
      out.push(finding);
      if (out.length > ${MAX_FINDINGS}) {
        break;
      }
    }
  }
  return JSON.stringify(out);
})()
`;

const SETTINGS = `JSON.stringify({ events: ${BUNDLE_GLOBAL}.events, globs: ${BUNDLE_GLOBAL}.globs })`;

/**
 * Reads what a bundled detector exports as `events` and `globs`.
 *
 * The bundle is evaluated once, at build time, under the limits a detector
 * run gets. The result is unvalidated: whatever the module exported.
 */
export async function readExports(bundle: string, limits: Limits = DEFAULT_LIMITS): Promise<{ events?: unknown; globs?: unknown }> {
  const { json, error } = await evaluate(`${bundle}\n;${SETTINGS}`, null, limits);
  if (json === null) {
    throw new Error(`detector.ts could not be loaded: ${error ?? "it returned nothing"}`);
  }
  return JSON.parse(json) as { events?: unknown; globs?: unknown };
}

/** Evaluates a script in a fresh isolate and returns the string it ends with. */
async function evaluate(script: string, ctx: Ctx | null, limits: Limits): Promise<{ json: string | null; error: string | null }> {
  const QuickJS = await loadSandbox();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + limits.ms));
  const vm = runtime.newContext();

  let json: string | null = null;
  let error: string | null = null;
  try {
    if (ctx) {
      const input = vm.newString(JSON.stringify(ctx));
      vm.setProp(vm.global, "__ctx", input);
      input.dispose();
    }
    const result = vm.evalCode(script, "detector.js");
    if (result.error) {
      error = describeError(vm.dump(result.error), limits);
      result.error.dispose();
    } else {
      json = vm.getString(result.value);
      result.value.dispose();
    }
  } catch (thrown) {
    error = describeError(thrown, limits);
  } finally {
    vm.dispose();
    runtime.dispose();
  }
  return { json, error };
}

/**
 * Runs one bundled detector against one context inside a fresh isolate.
 *
 * The isolate gets the context as a JSON string and hands back a JSON string.
 * It has no filesystem, no network, no process and no way to call the host.
 * A detector that runs out of time or memory ends with an error, never with
 * a hung hook.
 */
export async function runDetector(bundle: string, ctx: Ctx, limits: Limits = DEFAULT_LIMITS): Promise<DetectorRun> {
  const started = performance.now();
  const { json, error } = await evaluate(`${bundle}\n;${RUN}`, ctx, limits);
  const ms = performance.now() - started;
  if (json === null) {
    return { findings: [], error: error ?? "the detector returned nothing", dropped: [], ms };
  }
  const { findings, dropped } = validateFindings(json, ctx);
  return { findings, error: null, dropped, ms };
}

function describeError(dumped: unknown, limits: Limits): string {
  const message =
    typeof dumped === "object" && dumped !== null && "message" in dumped
      ? String((dumped as { message: unknown }).message)
      : String(dumped);
  if (message.includes("interrupted")) {
    return `the detector ran longer than ${limits.ms} ms and was stopped`;
  }
  if (message.includes("out of memory")) {
    return `the detector used more than ${limits.memoryBytes / 1024 / 1024} MB and was stopped`;
  }
  const name =
    typeof dumped === "object" && dumped !== null && "name" in dumped ? `${String((dumped as { name: unknown }).name)}: ` : "";
  return `${name}${message}`;
}

/**
 * Keeps the findings a host can trust.
 *
 * Evidence ends up in the agent's context, so it must be a verbatim piece of
 * what the detector was shown. That keeps a detector from composing text of
 * its own at runtime: the only words it can put in front of an agent are
 * words that were already there.
 */
export function validateFindings(json: string, ctx: Ctx): { findings: Finding[]; dropped: string[] } {
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

  const lineCount = ctx.file?.lines.length ?? 0;
  for (const raw of parsed) {
    if (findings.length >= MAX_FINDINGS) {
      dropped.push(`more than ${MAX_FINDINGS} findings; the rest were dropped`);
      break;
    }
    if (typeof raw !== "object" || raw === null) {
      dropped.push("a finding that is not an object");
      continue;
    }
    const candidate = raw as Record<string, unknown>;
    const evidence = typeof candidate.evidence === "string" ? candidate.evidence.trim() : "";
    if (evidence === "") {
      dropped.push("a finding without evidence");
      continue;
    }
    if (evidence.length > MAX_EVIDENCE_LENGTH) {
      dropped.push(`evidence longer than ${MAX_EVIDENCE_LENGTH} characters`);
      continue;
    }
    if (!ctx.text.includes(evidence)) {
      dropped.push(`evidence that does not occur in the input: ${JSON.stringify(evidence.slice(0, 60))}`);
      continue;
    }
    const finding: Finding = { evidence };
    if (candidate.line !== undefined) {
      const line = candidate.line;
      if (typeof line !== "number" || !Number.isInteger(line) || line < 1 || line > lineCount) {
        dropped.push(`a finding on line ${String(line)}, which the file does not have`);
        continue;
      }
      finding.line = line;
    }
    if (candidate.depth !== undefined) {
      if (candidate.depth !== "pointer" && candidate.depth !== "full") {
        dropped.push(`a finding with unknown depth ${JSON.stringify(candidate.depth)}`);
        continue;
      }
      finding.depth = candidate.depth;
    }
    findings.push(finding);
  }
  return { findings, dropped };
}
