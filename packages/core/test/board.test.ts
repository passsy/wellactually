import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { API_VERSION } from "@wellactually/sdk";
import { ADVICE_BUDGET, ADVICE_MAX, adviceBytes, adviceLengthWarnings, buildBundle, DetectorPool, describeFinding, fileCtx, forgetShown, frame, frameEvents, readConfig, readShown, runBoard, SESSION_MAX_AGE_MS, sweepShown, textCtx, writeCached, writeConfig, writeShown } from "../src/node.ts";

const sdk = `import { onPrompt } from "@wellactually/sdk/v3";`;
const handlers = [{ event: "prompt" as const, globs: [] }];

describe("running the advisory board", () => {
  test("a fork that shares a hash with what it copied speaks under its own name", async () => {
    process.env.WELLACTUALLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-board-"));
    const bundle = await buildBundle({ "detector.ts": `${sdk} onPrompt({ detect: () => [{ match: "hello" }] });` });
    const hash = "c".repeat(64);
    // Cached while the original still ran.
    writeCached({ id: "ana/grid", version: 3, hash, manifest: { title: "Grid", summary: "", tags: [], events: ["prompt"], globs: [], handlers, api: API_VERSION }, advice: "Use grid.", bundle });

    const run = await runBoard(textCtx("prompt", "hello"), { syncedAt: null, entries: [{ id: "me/grid", version: 1, hash, enabled: true }] });
    expect(run.failures).toEqual([]);
    expect(run.firings.map((firing) => [firing.principle.id, firing.principle.version])).toEqual([["me/grid", 1]]);
  });

  test("reports every detector that ran, and why the others did not", async () => {
    process.env.WELLACTUALLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-board-"));
    const fires = await buildBundle({ "detector.ts": `${sdk} onPrompt({ detect: () => [{ match: "hello" }] });` });
    const quiet = await buildBundle({ "detector.ts": `${sdk} onPrompt({ detect: () => [] });` });
    const prompt = { title: "T", summary: "", tags: [], events: ["prompt" as const], globs: [], handlers, api: API_VERSION };
    const write = { ...prompt, events: ["write" as const], handlers: [{ event: "write" as const, globs: ["**/*.ts"] }] };
    writeCached({ id: "a/fires", version: 2, hash: "1".repeat(64), manifest: prompt, advice: "A", bundle: fires });
    writeCached({ id: "a/quiet", version: 1, hash: "2".repeat(64), manifest: prompt, advice: "A", bundle: quiet });
    writeCached({ id: "a/writes", version: 1, hash: "3".repeat(64), manifest: write, advice: "A", bundle: quiet });
    const entries = ["fires", "quiet", "writes", "off"].map((name, index) => ({ id: `a/${name}`, version: 1, hash: String(index + 1).repeat(64), enabled: true }));

    const run = await runBoard(textCtx("prompt", "hello"), { syncedAt: null, entries }, new Set(["a/off"]));
    expect(run.detectors.map(({ id, findings, error }) => ({ id, findings, error }))).toEqual([
      { id: "a/fires", findings: [{ match: "hello" }], error: null },
      { id: "a/quiet", findings: [], error: null },
    ]);
    expect(run.skipped).toEqual([
      { id: "a/writes", reason: "globs" },
      { id: "a/off", reason: "off" },
    ]);
  });
});

describe("running the advisory board on worker threads", () => {
  const worker = path.resolve(import.meta.dirname, "../../cli/src/worker.ts");

  test("gives what one thread gives, in the order of the advisory board, and stops what never ends", async () => {
    process.env.WELLACTUALLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-pool-"));
    const manifest = { title: "T", summary: "", tags: [], events: ["prompt" as const], globs: [], handlers, api: API_VERSION };
    const fires = await buildBundle({ "detector.ts": `${sdk} onPrompt({ detect: (event) => [{ match: event.text }] });` });
    const quiet = await buildBundle({ "detector.ts": `${sdk} onPrompt({ detect: () => [] });` });
    const endless = await buildBundle({ "detector.ts": `${sdk} onPrompt({ detect: () => { for (;;) {} } });` });
    const reads = await buildBundle({ "detector.ts": `import fs from "node:fs"; ${sdk} onPrompt({ detect: (event) => (fs.existsSync(${JSON.stringify(worker)}) ? [{ match: event.text }] : []) });` });
    const bundles = [fires, quiet, endless, reads, fires, quiet, fires, reads, quiet, fires];
    const entries = bundles.map((bundle, index) => {
      const hash = index.toString(16).padStart(64, "0");
      writeCached({ id: `x/p${index}`, version: 1, hash, manifest, advice: "A", bundle });
      return { id: `x/p${index}`, version: 1, hash, enabled: true };
    });
    const lockfile = { syncedAt: null, entries };
    const ctx = textCtx("prompt", "hello", null);

    const single = await runBoard(ctx, lockfile);
    const pool = new DetectorPool(worker, 4);
    try {
      const parallel = await runBoard(ctx, lockfile, new Set(), pool, 1);
      expect(parallel.firings.map((firing) => firing.principle.id)).toEqual(["x/p0", "x/p3", "x/p4", "x/p6", "x/p7", "x/p9"]);
      expect(parallel.firings).toEqual(single.firings);
      expect(parallel.failures).toEqual([{ id: "x/p2", error: "the detector ran longer than 100 ms and was stopped" }]);
      expect(parallel.failures).toEqual(single.failures);
      // Below the threshold no thread is asked.
      expect((await runBoard(ctx, lockfile, new Set(), pool, 11)).firings).toEqual(single.firings);
    } finally {
      await pool.close();
    }
  });

  test("a script that never serves detectors fails them instead of hanging the hook", async () => {
    const idle = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-idle-")), "idle.mjs");
    fs.writeFileSync(idle, "process.exit(0);\n");
    const pool = new DetectorPool(idle, 2);
    try {
      const results = await pool.run(textCtx("prompt", "x"), [{ bundle: "a", api: API_VERSION }, { bundle: "b", api: API_VERSION }], performance.now() + 1000, "skipped");
      expect(results.map((result) => result.error)).toEqual(["no worker thread was left to run it", "no worker thread was left to run it"]);
    } finally {
      await pool.close();
    }
  });
});

describe("what the agent is shown", () => {
  const file = fileCtx("write", "lib/session.dart", "class Session {\n  late User user;\n}");
  const principle = { id: "ana/avoid-late", version: 1, hash: "a".repeat(64), manifest: { title: "Avoid late", summary: "Make it nullable.", tags: [], events: [], globs: [], handlers: [] }, advice: "# Avoid late\n\nThe whole advice.", bundle: "" };

  test("quotes the line a finding names, from the event", () => {
    expect(describeFinding(file, { line: 2 })).toBe("line 2: late User user;");
    expect(describeFinding(file, { line: 2, match: "late" })).toBe('line 2, "late": late User user;');
    expect(describeFinding(file, { line: 1, endLine: 3 })).toBe("lines 1-3: class Session {");
    // A match that is the whole line would only repeat it.
    expect(describeFinding(file, { line: 3, match: "}" })).toBe("line 3: }");
    expect(describeFinding(textCtx("prompt", "why late final"), { match: "late final" })).toBe('"late final"');
    expect(describeFinding(file, {})).toBe("the file lib/session.dart");
    expect(describeFinding(file, { match: "late" })).toBe('"late"');
    expect(describeFinding(file, { file: "assets/hero.jpg" })).toBe("the file assets/hero.jpg");
    expect(describeFinding(file, { line: 2, file: "assets/hero.jpg" })).toBe("the file assets/hero.jpg, from line 2: late User user;");
    expect(describeFinding(file, { file: "lib/session.dart" })).toBe("the file lib/session.dart");
    expect(describeFinding(textCtx("command", "convert a.png hero.jpg"), { file: "hero.jpg", match: "hero.jpg" })).toBe('the file hero.jpg, from "hero.jpg"');
    expect(describeFinding(textCtx("prompt", "why late final"), {})).toBeNull();
  });

  test("lists every place once, above the advice", () => {
    const text = frame(file, [{ principle, findings: [{ line: 2 }, { line: 2 }, { line: 1, endLine: 3 }, {}] }]);
    expect(text).toContain('<principle id="ana/avoid-late" expert="ana" title="Avoid late">\n- line 2: late User user;\n- lines 1-3: class Session {\n- the file lib/session.dart\n\n# Avoid late');
  });

  test("shows only the advice for a finding that names no place", () => {
    const text = frame(textCtx("prompt", "anything"), [{ principle, findings: [{ depth: "pointer" }] }]);
    expect(text).toContain('title="Avoid late">\nMake it nullable.\n</principle>');
  });

  test("puts the files of one change in one block, with the preamble and the rating said once", () => {
    const other = fileCtx("write", "lib/user.dart", "class User {\n  late String name;\n}");
    const { text, full, shown } = frameEvents([
      { ctx: file, firings: [{ principle, findings: [{ line: 2 }] }] },
      { ctx: textCtx("prompt", "quiet"), firings: [] },
      { ctx: other, firings: [{ principle, findings: [{ line: 2 }] }] },
    ]);
    expect(text.match(/<wellactually>/g)).toHaveLength(1);
    expect(text.match(/rate_principle/g)).toHaveLength(1);
    expect(text).toContain("write lib/session.dart: ");
    expect(text).toContain("write lib/user.dart: ");
    // The full advice once, the summary after that.
    expect(text.match(/The whole advice\./g)).toHaveLength(1);
    expect(text).toContain("- line 2: late String name;\n\nMake it nullable.");
    expect(full).toEqual(new Set([principle.hash]));
    expect(shown.map((event) => event.ctx)).toEqual([file, other]);
  });

  test("the longest advice agents are shown in full does fit in full on its own", () => {
    const ctx = fileCtx("write", `packages/${"deeply/nested/".repeat(6)}feature_screen_controller.dart`, `${"x".repeat(200)}\n`);
    const longest = { ...principle, id: "someone-long/a-principle-with-a-long-name", manifest: { ...principle.manifest, title: "T".repeat(120), summary: "S".repeat(200) }, advice: "a".repeat(ADVICE_MAX) };
    const { full, text } = frameEvents([{ ctx, firings: [{ principle: longest, findings: [{ line: 1, match: "x".repeat(80) }] }] }]);
    expect(full).toEqual(new Set([longest.hash]));
    expect(adviceBytes(text)).toBeLessThanOrEqual(ADVICE_BUDGET);
    expect(adviceLengthWarnings(longest.advice).join()).not.toMatch(/only shown its summary/);
  });

  test("warns about advice on the long end, and about advice agents only see the summary of", () => {
    expect(adviceLengthWarnings("a".repeat(4000))).toEqual([]);
    expect(adviceLengthWarnings("a".repeat(4001)).join()).toMatch(/4,001 bytes, on the long end/);
    expect(adviceLengthWarnings("a".repeat(7501)).join()).toMatch(/Agents are only shown its summary/);
    // Codex counts bytes, so 3,000 arrows are 9,000 bytes however few characters they are.
    expect(adviceLengthWarnings("→".repeat(3000)).join()).toMatch(/9,000 bytes, more than the 7,500/);
  });

  test("counts the budget in bytes, so advice full of non-ASCII text still fits", () => {
    const wide = { ...principle, advice: `# Umlaute\n\n${"ä→".repeat(1800)}` };
    const { full, text } = frameEvents([{ ctx: file, firings: [{ principle: wide, findings: [{ line: 2 }] }] }]);
    // 3,600 characters would fit, 9,000 bytes do not.
    expect(full).toEqual(new Set());
    expect(adviceBytes(text)).toBeLessThanOrEqual(ADVICE_BUDGET);
  });

  test("stays within the budget: full advice while it fits, then summaries, then fewer files", () => {
    const long = { ...principle, advice: `# Avoid late\n\n${"x".repeat(3000)}` };
    const files = Array.from({ length: 40 }, (_, index) => fileCtx("write", `lib/f${index}.dart`, "late int a;"));
    const principles = [0, 1, 2, 3].map((index) => ({ ...long, id: `ana/p${index}`, hash: String(index).repeat(64) }));
    const events = files.map((ctx) => ({ ctx, firings: principles.map((item) => ({ principle: item, findings: [{ line: 1 }] })) }));

    const { text, full, shown } = frameEvents(events, new Set(), 9000);
    expect(text.length).toBeLessThanOrEqual(9000);
    // Two of four fit in full; the others explain themselves on a later event.
    expect(full).toEqual(new Set([principles[0]?.hash, principles[1]?.hash]));
    expect(shown.length).toBeGreaterThan(1);
    expect(shown.length).toBeLessThan(files.length);
    expect(text).toContain(`Principles also fired on ${files.length - shown.length} more files of this change.`);
    expect(text.endsWith("</wellactually>")).toBe(true);
  });
});

describe("remembering what a session was shown", () => {
  test("a subagent keeps its own list, because the main thread's advice is not in its context", () => {
    process.env.WELLACTUALLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-shown-"));
    writeShown("s1", new Set(["a"]));

    expect([...readShown("s1", "agent-7")]).toEqual([]);
    writeShown("s1", new Set(["b"]), "agent-7");
    expect([...readShown("s1")]).toEqual(["a"]);
    expect([...readShown("s1", "agent-7")]).toEqual(["b"]);
  });

  test("a compaction forgets every agent of that session and no other session", () => {
    process.env.WELLACTUALLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-shown-"));
    writeShown("s1", new Set(["a"]));
    writeShown("s1", new Set(["b"]), "agent-7");
    writeShown("s10", new Set(["c"]));

    forgetShown("s1");

    expect(readShown("s1").size).toBe(0);
    expect(readShown("s1", "agent-7").size).toBe(0);
    expect([...readShown("s10")]).toEqual(["c"]);
  });

  test("the list of a session nobody heard from in a week is swept away", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "wellactually-shown-"));
    process.env.WELLACTUALLY_HOME = home;
    writeShown("crashed", new Set(["a"]));
    writeShown("running", new Set(["b"]));
    const old = (Date.now() - SESSION_MAX_AGE_MS - 60_000) / 1000;
    fs.utimesSync(path.join(home, "sessions", "crashed.json"), old, old);

    expect(sweepShown()).toBe(1);
    expect(readShown("crashed").size).toBe(0);
    expect([...readShown("running")]).toEqual(["b"]);
  });
});
