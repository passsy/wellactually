import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { zodSchema } from "../../review-inbox/zod-schema.mts";
import { hasDetector } from "@wellactually/core/node";
import { TOOLS as FINDINGS_TOOLS } from "../../review-inbox/tools.mts";
import { REVIEW_REPORT_MS } from "../../board/src/registry/review-reports.ts";
import { startInBackground } from "./hook/hook.ts";
import { ensureCodexHooks, installedByCodex } from "./codex-user-hooks.ts";
import { askCodexHooksNeedReview, codexHooksSilent, HOOKS_NEED_REVIEW, noteCodexServer } from "../../board/src/codex-hooks.ts";
import { claimReport } from "../../board/src/detections.ts";
import { appToolMeta, drawsCards, registerReviewCard } from "../../review-inbox/serve/app.mts";
import { startUi } from "../../review-inbox/serve/http.mts";
import { reviewCardsEnabled } from "../../review-inbox/serve/port.mts";
import { currentWorkspace, type Workspace } from "../../review-inbox/store/workspace.mts";
import { scaffold } from "../../board/src/files.ts";
import { readCached, readLockfile, readConfig, writeConfig } from "../../board/src/board.ts";
import { switchedOff } from "../../board/src/switches.ts";
import { switchPrinciple } from "../../board/src/switches.ts";
import { raterOf } from "../../board/src/registry/rater.ts";
import { ratePrinciple, RegistryError, type DraftResult, type Outcome } from "../../board/src/registry/client.ts";
import {
  ApprovalError,
  changeVisibility,
  principleHistory,
  probePrinciple,
  publishPrinciple,
  pullPrinciple,
  releasePrinciple,
  showPrinciple,
  renderHistory,
  renderProbe,
  renderPublished,
  renderPull,
  renderRelease,
  renderShow,
  renderVisibility,
  renderReport,
  renderSwitch,
  renderTry,
  testPrinciple,
  tryPrinciple,
} from "./commands.ts";

const AUTHORING_GUIDE = `A principle is a directory with three parts:

The name of the directory is the principle's id.

- principle.md: plain markdown, the advice an agent reads. No header.
  Its \`# heading\` is the title. The paragraph right below it is the summary shown in lists: one sentence, at most 200 characters.
- detector.ts: registers a handler per event it reacts to, at the top level of the file:
  \`onWrite({ globs: ["**/*.ts", "!**/*.d.ts"], *detect(event) { for (const written of event.written) { if (/\\benum\\b/.test(written.text)) { yield { line: written.line }; } } } });\`
  Each call takes one object: \`globs\` where the event has a file, and \`detect\`. Write it over several lines, \`globs\` and \`*detect(event) {\` each on their own line, with plain if statements. The star makes \`detect\` a generator method, because an arrow function cannot yield.
  The handlers are \`onWrite\` (the agent wrote a file), \`onRead\` (it read one), \`onPrompt\` (the user typed, or the agent briefed a subagent), \`onCommand\` (a shell command is about to run), \`onOutput\` (what a command printed), \`onDelete\` (it deleted a file) and \`onTool\` (the agent is about to call a tool of an MCP server). A detector registers as many as it needs, also several for one event.
  \`onWrite\`, \`onRead\` and \`onDelete\` take globs for the path from the project root: \`**\`, \`*\`, \`?\`, \`{a,b}\`, and a leading \`!\` excludes. Without globs the handler runs on every file.
  Each handler gets the event of its kind. All have \`event.text\`, \`event.lines\` and \`event.project\`. Write, read and delete have \`event.file\` (\`path\` absolute, \`relativePath\` from the project root, \`name\`, \`ext\`, \`content\`, \`lines\`, \`isNew\`). Write has \`event.written\`, the lines the agent wrote as \`{ line, text }\`: judge those, not the whole file. \`text\` is the line as it is in the file, comments and strings included, so skip a comment line yourself where it matters: \`if (written.text.trim().startsWith("//")) { continue; }\`. Write also has \`event.removed\`, the lines the agent removed as \`{ line, text, removed: true }\`, where \`line\` is the line it had before. A changed line is removed as it was and written as it is. On delete \`event.file\` is the file as it was, and every line of it is in \`event.removed\`, so one helper over \`event.removed\` serves \`onWrite\` and \`onDelete\`. Command and output have \`event.command\`. Tool has \`event.server\` (the MCP server as the agent names it: "t3-code" in Claude Code, "t3_code" in Codex), \`event.tool\` (e.g. "pull_request_create") and \`event.input\` (the arguments the agent passes), and its \`text\` is the input as indented JSON. Judge a tool by \`event.tool\` rather than the server name, which differs between machines: \`onTool({ *detect(event) { if (event.tool === "pull_request_create") { yield {}; } } })\`. A tool call is not a shell command, so \`onCommand\` never sees one.
  Prompt, command, output and tool have \`event.cwd\`, the folder the session runs in. To keep a prompt handler to one kind of project, look from there: \`onPrompt({ *detect(event) { if (findUp("pubspec.yaml", event.cwd)) { yield* mentioned(event, ["riverpod"]); } } })\`. \`findUp(name, from)\` from the SDK returns the nearest file of that name upwards, or null.
  A handler yields findings. A helper that returns a list of them is passed on with \`yield*\`. A finding is \`{ line?, endLine?, match?, file?, depth?, removed? }\` and nothing in it is required.
  A finding without a \`line\` in \`onWrite\` or \`onRead\` points at the file: \`yield {}\` says the file itself is the problem, for its name, its place or something it lacks. Never pick a first line to stand in for the file. Elsewhere \`yield {}\` just fires.
  \`file\` points at another file than the one of the event, as a path from the project root or an absolute one: \`yield { line: written.line, file: "assets/hero.jpg" }\` for a jpg that should be a webp. \`line\` and \`match\` stay about the event. The file has to exist or occur verbatim in the event, or it is left out and the finding still fires.
  \`line\` is the 1-based line of the file, or of what a command printed. The agent is shown that line, quoted by the host, so a finding carries no text of its own. \`endLine\` is for a finding that spans lines. Prompt, command and tool findings have no line. \`removed: true\` says \`line\` and \`endLine\` name removed lines by the line they had before, and the host quotes them from \`event.removed\`: \`yield removed\` or \`yield { line: removed.line, removed: true }\`.
  \`match\` is the exact text that triggered: the keyword in a prompt, a piece of a line. It must occur verbatim in the event, on the named line when there is one, and may not span lines. A match that does not is left out and the finding still fires. Text read from another file cannot be a match.
  \`depth: "pointer"\` shows only the summary, for a word that matched while nothing is known to be wrong. \`mentioned(event, ["some phrase"])\` from the SDK returns that for a prompt. It finds a name where it stands alone, in any case and with or without separators (rxdart, rx_dart, RxDart).
  It imports from \`@wellactually/detector-sdk/v5\`. The v5 in the path is the detector API version it is written against, and its tests import from the same version. Keep the path as scaffold wrote it; what follows describes version 5. A principle on v4 keeps working, without \`onTool\`, and one on v3 also without \`event.removed\` and \`onDelete\`; to use them, import from v5 in every file.
  It runs in an isolate without network or process. It may import @wellactually/detector-sdk/v5, node:fs, node:path, its own relative files, and packages from npm. A package needs an entry in a package.json in the principle folder, \`{ "dependencies": { "yaml": "^2.9.1" } }\`, and has to be installed with npm install. Its code is copied into the principle on publish, at the version that is installed then. A package may also come from a repository, \`"dart-kit": "github:owner/dart-kit#main"\`, and may then be TypeScript. Only plain JavaScript works: a package that needs Node or WebAssembly fails at build time. The bundle may be 1 MB. The licence of every package goes into the bundle. MIT, ISC, BSD, Apache-2.0 and the like pass by themselves when the package has its licence file. Any other licence, or none, has to be approved by the human when they publish, so prefer packages with a permissive licence.
  It can read other files with node:fs (readFileSync, existsSync, statSync, readdirSync; text only, read-only, sync only). Walk up from event.file.path to find a pubspec.yaml or package.json. event.project is the git root or null, do not rely on it.
- *.test.ts: the tests. Any number of files, each complete on its own, with the source it tests written inline.
  A test builds the event a detector receives and checks what the detector reports:
  \`expect(detect(write("lib/a.dart", content))).toEqual([{ line: 2 }])\`.
  Events come from \`write(path, content)\`, \`edit(path, contentAfterTheEdit, { written, removed, before })\`, \`read(path, content)\`, \`deleted(path, contentItHeld)\`, \`prompt(text)\`, \`command(text)\`, \`output(command, text)\` and \`tool(server, name, input)\`.
  \`edit\` is how to show that code which was already there is left alone: only \`written\` counts as written. \`removed\` is the text the agent took out, found in \`before\`, the file as it was, which gives each removed line its number.
  Import \`test\`, \`describe\` and \`expect\` from vitest, and the events, \`detect\` and \`source\` from @wellactually/detector-sdk/v5/test.
  For a detector that reads other files, put a small project into the principle, e.g. fixtures/flutter_app/pubspec.yaml, and pass it: \`detect(write("lib/a.dart", content), { project: "fixtures/flutter_app" })\`.
  The project sits at a made-up root, so never assert on absolute paths. \`write(path, content, { isNew: true })\` is a write that created the file.
  The tests are ordinary vitest files. Where the repository has vitest and @wellactually/detector-sdk installed, npm test runs them. run_tests always works and also checks the publish gates.
  To set a repository up for that: \`npm install --save-dev @wellactually/detector-sdk vitest\`, with "type": "module" and "test": "vitest run" in package.json.
  The registry runs them with a small copy of vitest: toEqual, toStrictEqual, toBe, toHaveLength, toContain, toContainEqual, toMatchObject, toBeTruthy, toBeFalsy, toBeNull, toBeUndefined, toBeDefined, toThrow, .not, test.each. Use only those. Tests are not async.

The tests must pass, make the detector fire at least once, and run it at least once on something it stays quiet on.
The registry runs the tests again on upload, and its result is the one that counts.

Loop: scaffold, edit, run_tests until green, probe against a real repository, add a quiet test for every false positive, publish_draft.
To change an existing principle: pull it, edit, run_tests, publish_draft. That releases its next revision.
publish_draft releases what passes. A package licence that needs the human's approval keeps it a draft, and release releases a draft that is waiting.
A principle is private until it is made public: publish_draft takes visibility public or private, and set_visibility changes it later.

Reading: show reads a principle by id, bare name or link. Use it to follow a link from one principle's advice to another.

Rating: when advice in an <wellactually> block was shown to you, tell its expert what it did with rate_principle_relevant, or with rate_principle_not_relevant when it fired on something it is not about, once per principle and task.
It is feedback to the author, not part of your task: leave it out of your answer, and out of your report when you are a subagent.`;

/** For tools that only look something up in the registry, which Codex then calls without asking its reviewer. */
const READS = { readOnlyHint: true, openWorldHint: false };

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function registerFindingsTools(server: McpServer, workspace: Workspace): void {
  registerReviewCard(server);
  for (const tool of FINDINGS_TOOLS) {
    if (tool.cardOnly && !reviewCardsEnabled()) continue;
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: zodSchema(tool.inputSchema),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      ...(appToolMeta(tool) ? { _meta: appToolMeta(tool) } : {}),
    }, async (args) => {
      try {
        if (tool.cardOnly && !drawsCards(server)) throw new Error("This tool is available only through the review card");
        if (tool.name === "claim_review_session") {
          (args as Record<string, unknown>).registry = readConfig().registry;
          const a = args as { sets?: { principles?: { id: string; version: number; hash?: string }[] }[] };
          for (const set of a.sets ?? []) for (const principle of set.principles ?? []) {
            const pinned = readLockfile().entries.find(e => e.id === principle.id && e.version === principle.version);
            if (pinned) principle.hash ??= pinned.hash;
          }
        }
        const result = await tool.run(args, workspace.repo);
        if (readConfig().stats && (tool.name === "begin_verification" || (tool.name === "get_review_session" && claimReport()))) {
          startInBackground("report-detections");
        }
        const reply = text(tool.says ? tool.says(result) : JSON.stringify(result, null, 2));
        return tool.card && drawsCards(server) ? { ...reply, structuredContent: (tool.forCard ? tool.forCard(args, workspace.repo) : result) as Record<string, unknown> } : reply;
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
      }
    });
  }
}

/** Serves the authoring verbs over stdio, so an agent can build and test a principle without a shell. */
export async function serveMcp(): Promise<void> {
  // A fix may land after the final aggregation upload. Keep checking without
  // a network call in CRUD operations, and without keeping a closed MCP alive.
  const reporting = setInterval(() => { if (readConfig().stats && claimReport()) startInBackground("report-detections"); }, REVIEW_REPORT_MS);
  reporting.unref();
  // The plugin's folder, above dist/ where this server runs. Codex is named by the plugin's own .codex-plugin/mcp.json.
  const pluginRoot = path.resolve(path.dirname(process.argv[1] ?? ""), "..");
  const codex = process.env.WELLACTUALLY_REVIEW_HOST === "codex";
  if (codex) {
    // Codex always starts this server, also for a plugin added by hand, so it keeps the user-level hooks in place.
    try {
      if (installedByCodex(pluginRoot)) ensureCodexHooks();
    } catch (error) {
      console.error(`Could not set up the Codex hooks: ${error instanceof Error ? error.message : String(error)}`);
    }
    noteCodexServer(pluginRoot, await askCodexHooksNeedReview());
  }
  const hooksNeedReview = () => codex && codexHooksSilent(pluginRoot);
  // Codex shows the model only the first line of a server's instructions.
  const instructions = hooksNeedReview() ? `${HOOKS_NEED_REVIEW}\n\n${AUTHORING_GUIDE}` : AUTHORING_GUIDE;
  const server = new McpServer({ name: "wellactually", version: "0.8.0" }, { instructions });
  // Instructions are easy to miss, so the first tool result says it once more while it still holds.
  let toldHooks = false;
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as { registerTool: unknown }).registerTool = (name: string, config: unknown, callback: (...args: unknown[]) => Promise<{ content?: unknown[] }>) =>
    register(name, config, async (...args: unknown[]) => {
      const result = await callback(...args);
      if (toldHooks || !hooksNeedReview()) {
        return result;
      }
      toldHooks = true;
      return { ...result, content: [...(result.content ?? []), { type: "text", text: HOOKS_NEED_REVIEW }] };
    });
  const workspace = currentWorkspace();
  registerFindingsTools(server, workspace);
  server.registerTool("list_principles", {
    description: "Current advisory board metadata for review filtering: id, version, short description and tags only. No full advice bodies. Pass the reviewed repo to respect project switches.",
    inputSchema: { repo: z.string() },
  }, async ({ repo }) => {
    const off = switchedOff(repo);
    return text(JSON.stringify(readLockfile().entries.flatMap(entry => {
      const cached = readCached(entry.hash);
      if (!cached || off.has(entry.id) || (hasDetector(cached.manifest) && !entry.enabled)) return [];
      return [{ id: entry.id, version: entry.version, description: cached.manifest.summary, tags: cached.manifest.tags ?? [] }];
    }), null, 2));
  });
  server.registerTool("get_principle", {
    description: "Load the full cached advisory-board principle by id for an assigned review. Returns its pinned cached version and advice; no registry fetch or board sync.",
    inputSchema: { id: z.string(), version: z.number().int().optional() },
  }, async ({ id, version }) => {
    const entry = readLockfile().entries.find(entry => entry.id === id);
    const cached = entry ? readCached(entry.hash) : null;
    if (!entry || !cached || (version !== undefined && version !== entry.version)) return { isError: true, ...text("Principle or requested version is not cached on this board: " + id) };
    return text(JSON.stringify({ id, version: entry.version, body: cached.advice }));
  });

  server.registerTool(
    "scaffold",
    {
      description:
        "Create a new principle directory that already passes run_tests. Returns the path. Edit principle.md, detector.ts and detector.test.ts from there.",
      inputSchema: {
        slug: z.string().describe("The principle's id, which becomes the directory name: 3 to 64 characters of a-z, 0-9 and dashes, e.g. avoid-late"),
        parent: z.string().describe("Absolute path of the directory to create it in"),
      },
    },
    async ({ slug, parent }) => text(`Created ${scaffold(slug, parent)}\n\n${AUTHORING_GUIDE}`),
  );

  server.registerTool(
    "run_tests",
    {
      description:
        "Build a principle and run its tests in the real isolate with the real limits. Reports each test, the publish gates and warnings about the advice text.",
      inputSchema: { dir: z.string().describe("Absolute path of the principle directory") },
    },
    async ({ dir }) => text(renderReport(await testPrinciple(dir))),
  );

  server.registerTool(
    "try",
    {
      description:
        "Show one input to a principle's detector and return the findings and the exact text an agent would be shown. Pass exactly one of file, prompt or command. Add output to a command to show what it printed after it ran.",
      inputSchema: {
        dir: z.string().describe("Absolute path of the principle directory"),
        file: z.string().optional().describe("Absolute path of a file, treated as just written by the agent"),
        read: z.boolean().optional().describe("Treat the file as read rather than written"),
        prompt: z.string().optional().describe("A user message"),
        command: z.string().optional().describe("A shell command the agent is about to run"),
        output: z.string().optional().describe("What the command printed. With it the event is the output of the command"),
      },
    },
    async ({ dir, ...input }) => text(renderTry(await tryPrinciple(dir, input))),
  );

  server.registerTool(
    "probe",
    {
      description:
        "Run a principle over every file of a repository and report the fire rate, timings and sample findings. A detector that fires on more than half of the files it looks at is rejected.",
      inputSchema: {
        dir: z.string().describe("Absolute path of the principle directory"),
        repo: z.string().describe("Absolute path of the repository to probe"),
      },
    },
    async ({ dir, repo }) => text(renderProbe(await probePrinciple(dir, repo))),
  );

  server.registerTool(
    "publish_draft",
    {
      description:
        "Upload a principle to the registry and release it as its next revision. The registry rebuilds it and reruns the tests, and releases it when they pass. A package licence that needs the human's approval keeps it a draft. Needs `wellactually login` to have been run once.",
      inputSchema: {
        dir: z.string().describe("Absolute path of the principle directory"),
        visibility: z
          .enum(["public", "private"])
          .optional()
          .describe("Who can see it: public for anyone, private for the user and private collections they share it with. Leave it out to keep it as it is; a new principle is private."),
      },
    },
    async ({ dir, visibility }) => {
      let result: DraftResult;
      try {
        // No approvals from here: a licence is approved by the human, at their terminal or on the website.
        result = await publishPrinciple(dir, { visibility });
      } catch (error) {
        if (error instanceof ApprovalError) {
          return text(`${error.message}\n\nThis is the human's decision. Show them the list and let them run the command. Do not approve a licence for them.`);
        }
        throw error;
      }
      const report = renderReport({ id: result.id, title: null, report: result.report });
      if (!result.accepted) {
        return text(`The registry refused the upload.\n\n${report}`);
      }
      return text(`${renderPublished(result)}\n\n${report}`);
    },
  );

  server.registerTool(
    "set_visibility",
    {
      description:
        "Make one of the user's own principles public or private. Public: anyone can read it and put it on their advisory board. Private: only the user, and private collections they share it with. A principle without a release becomes public with its first release. A visibility set in its package.json wins, and then this is refused.",
      inputSchema: {
        id: z.string().describe("expert/principle, or just the principle id for one of the user's own"),
        visibility: z.enum(["public", "private"]).describe("public or private"),
      },
    },
    async ({ id, visibility }) => {
      try {
        return text(renderVisibility(await changeVisibility(id, visibility)));
      } catch (error) {
        if (error instanceof RegistryError) {
          return text(`Visibility not changed: ${error.message}`);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "release",
    {
      description: "Release the waiting draft of one of the user's own principles, for instance one an earlier upload left, so it runs as its next revision.",
      inputSchema: { id: z.string().describe("expert/principle, or just the principle id for one of the user's own") },
    },
    async ({ id }) => {
      try {
        return text(renderRelease(await releasePrinciple(id)));
      } catch (error) {
        if (error instanceof RegistryError) {
          return text(`Not released: ${error.message}`);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "pull",
    {
      description:
        "Download an existing principle's files from the registry into a directory, to update it. Returns the user's own draft when one is waiting, including edits made in the browser, otherwise the newest release. Then edit, run_tests and publish_draft.",
      inputSchema: {
        id: z.string().describe("expert/principle, or just the principle id for one of the user's own. Append @3 for a specific revision."),
        dir: z.string().describe("Absolute path of the directory to write the files to"),
        force: z.boolean().optional().describe("Replace the files of a directory that already has some. Discards local edits."),
      },
    },
    async ({ id, dir, force }) => text(renderPull(await pullPrinciple(id, dir, force ?? false))),
  );

  server.registerTool(
    "show",
    {
      description:
        "Read a principle: its advice as an agent is shown it, with author, tags, visibility and link. Use it to follow a link to another principle that advice mentions, or to look one up by name. A private principle reads only for those it is shared with.",
      inputSchema: {
        principle: z
          .string()
          .describe("expert/principle such as passsy/avoid-late, optionally with @revision; a bare principle id; or its link, e.g. https://wellactually.dev/p/passsy/avoid-late"),
      },
      annotations: READS,
    },
    async ({ principle }) => {
      try {
        return text(renderShow(await showPrinciple(principle)));
      } catch (error) {
        if (error instanceof RegistryError) {
          return text(`Not shown: ${error.message}`);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "history",
    {
      description:
        "Show a principle's revisions, newest first, like a commit log: revision, hash, date and which files changed. Includes the user's own unreleased draft.",
      inputSchema: { id: z.string().describe("expert/principle, or just the principle id for one of the user's own") },
      annotations: READS,
    },
    async ({ id }) => text(renderHistory(await principleHistory(id))),
  );

  // Which tool the agent picks says whether the advice was about its work, so neither has a field that depends on another.
  const rateInput = {
    id: z.string().describe('The id from the <principle id="..."> tag, e.g. passsy/avoid-late'),
    replaces: z
      .string()
      .optional()
      .describe("The rating id an earlier rating of this principle returned, to change that rating instead of adding one. Works for 24 hours."),
  };
  const privacy =
    "Sends only the principle revision and the outcome, nothing about the code or the conversation, to the registry the user signed in to, and only while the user has reporting switched on (set_stats). Returns a rating id: pass it as replaces to change this rating within 24 hours, for example from noted to adjust once the work exists.";
  // Without annotations Codex treats a tool as destructive and open world and asks
  // its reviewer, which sees no request from the user and turns the rating down.
  // A rating reaches only the registry this plugin belongs to and changes nothing on the machine.
  const rateAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const rate = async (id: string, outcome: Outcome, replaces: string | undefined, meta: Parameters<typeof raterOf>[1]) => {
    try {
      return text(await ratePrinciple(id, outcome, replaces, await raterOf(server.server.getClientVersion()?.name, meta)));
    } catch (error) {
      if (error instanceof RegistryError) {
        // A rating is a courtesy. Failing to send one must not derail the agent's task.
        return text(`The rating was not recorded: ${error.message} Carry on with your task.`);
      }
      throw error;
    }
  };

  server.registerTool(
    "rate_principle_relevant",
    {
      description:
        "Tell the author of a principle what its advice did, after it was shown to you in an <wellactually> block. Use it when the advice is about your work: it would matter if your work were worse, even when your work already complies. Rate once per principle and task. adjust: because of the advice you change, or will change, what you do. keep: your work is fine as it is, it already complies or you leave it on purpose. noted: the work the advice is about has not happened yet, such as commit advice before the commit; rate again with replaces once it exists. unclear: you cannot tell what the advice wants. wrong: following the advice would make the result worse. " +
        privacy,
      inputSchema: {
        ...rateInput,
        effect: z.enum(["adjust", "keep", "noted", "unclear", "wrong"]).describe("adjust, keep, noted, unclear or wrong"),
      },
      annotations: rateAnnotations,
    },
    async ({ id, effect, replaces }, extra) => rate(id, effect, replaces, extra._meta),
  );

  server.registerTool(
    "rate_principle_not_relevant",
    {
      description:
        "Tell the author of a principle that its detector fired on something its advice is not about, after it was shown to you in an <wellactually> block: a word that means something else here, a topic mentioned in passing, text you are not writing. Not for advice that applies to your work when your work already complies: that is rate_principle_relevant with keep. Where a file lives does not matter; only a scope the advice itself names does. Rate once per principle and task. " +
        privacy,
      inputSchema: rateInput,
      annotations: rateAnnotations,
    },
    async ({ id, replaces }, extra) => rate(id, "not_relevant", replaces, extra._meta),
  );

  const switchInput = {
    id: z.string().describe('The id from the <principle id="..."> tag, e.g. passsy/avoid-late'),
    scope: z
      .enum(["project", "global"])
      .describe("project: only in the project being worked on, recorded in .wellactually.json at its root. global: everywhere on this machine."),
    dir: z.string().optional().describe("A directory inside the project, for scope project. Defaults to where the agent was started; required in Codex."),
  };
  const switchTool = (on: boolean) => async ({ id, scope, dir }: { id: string; scope: "project" | "global"; dir?: string }) => {
    // Codex starts this server in the plugin's own folder, which is no project of the user's.
    if (scope === "project" && dir === undefined && fs.existsSync(path.join(process.cwd(), "dist", "wellactually.mjs"))) {
      return text("Pass dir, a directory inside the project: this server does not run in the project, so it cannot tell which one is meant.");
    }
    try {
      return text(renderSwitch(switchPrinciple(id, on, scope, dir ?? process.cwd()), on));
    } catch (error) {
      return text((error as Error).message);
    }
  };

  server.registerTool(
    "disable_principle",
    {
      description:
        "Switch a principle off, for this project or everywhere on this machine. Use it when the user asks for it, for instance because a principle does not fit a codebase. Do not use it on your own to get rid of advice you were just shown: say that the advice does not fit, rate it, and let the user decide. Takes effect with the next edit.",
      inputSchema: switchInput,
    },
    switchTool(false),
  );

  server.registerTool(
    "enable_principle",
    {
      description: "Switch a principle on again that was switched off with disable_principle, in the same scope it was switched off in.",
      inputSchema: switchInput,
    },
    switchTool(true),
  );

  server.registerTool(
    "set_stats",
    {
      description:
        "Switch on or off what this machine reports to the registry: how often each principle fired, as a count per day, and the ratings you give. Only when the user asks. Leave on out to read the current setting.",
      inputSchema: {
        on: z.boolean().optional().describe("true to report, false to send nothing. Left out, the setting stays as it is."),
      },
    },
    async ({ on }) => {
      if (on !== undefined) {
        writeConfig({ ...readConfig(), stats: on });
      }
      return text(
        readConfig().stats
          ? "Reporting is on: the sync at session start sends how often each principle fired, as a count per day, and ratings are sent. No file, prompt or finding is sent."
          : "Reporting is off: nothing about what fires on this machine is sent, and no rating.",
      );
    },
  );

  const transport = new StdioServerTransport();
  const closed = new Promise<void>(resolve => {
    server.server.onclose = () => resolve();
    process.stdin.once("end", () => resolve());
  });
  await server.connect(transport);
  const ui = await startUi(workspace).catch(error => { process.stderr.write(`Findings UI unavailable: ${String(error)}\n`); return null; });
  // Stay up until the client goes away, then let the process end.
  await closed;
  await ui?.close();
}
