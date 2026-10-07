import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { scaffold } from "@wellactually/core/node";
import { z } from "zod";
import { ratePrinciple, RegistryError } from "./registry.ts";
import {
  principleHistory,
  probePrinciple,
  publishPrinciple,
  pullPrinciple,
  renderHistory,
  renderProbe,
  renderPull,
  renderReport,
  renderTry,
  testPrinciple,
  tryPrinciple,
} from "./commands.ts";

const AUTHORING_GUIDE = `A principle is a directory with three parts:

The name of the directory is the principle's id.

- principle.md: plain markdown, the advice an agent reads. No header.
  Its \`# heading\` is the title. The paragraph right below it is the summary shown in lists: one sentence, at most 200 characters.
- detector.ts: \`export function* detect(ctx)\` yielding findings \`{ line?, evidence, depth? }\`.
  It also says when it runs: \`export const events = ["write"]\` (write, read, prompt, command) and \`export const globs = ["**/*.ts"]\`.
  It runs in an isolate without filesystem, network or process. It may import @wellactually/sdk and its own relative files.
  Evidence must be text that occurs verbatim in the input, or the host drops the finding.
- cases/: one file per case. \`fires-*\` must produce a finding, \`quiet-*\` must produce none.
  \`.prompt.txt\` is a user message, \`.command.txt\` a shell command, \`.read.<ext>\` a file the agent only read; anything else is a file the agent wrote.
  cases/expect.json may pin the lines a firing case reports and the path the detector sees.

A principle needs at least one fires-* case that passes and one quiet-* case.
The registry runs the cases again on upload, and its result is the one that counts.

Loop: scaffold, edit, run_cases until green, probe against a real repository, add quiet cases for false positives, publish_draft.
To change an existing principle: pull it, edit, run_cases, publish_draft. That creates the draft of its next version.
A draft is private. Releasing it is a click by the human on the website, where the same files can also be edited.

Rating: when advice in an <wellactually> block was shown to you, tell its advisor how it went with rate_principle, once per principle and task.
It is feedback to the author, not part of your task, and it never needs the user's attention.`;

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

/** Serves the authoring verbs over stdio, so an agent can build and test a principle without a shell. */
export async function serveMcp(): Promise<void> {
  const server = new McpServer({ name: "wellactually", version: "0.2.0" }, { instructions: AUTHORING_GUIDE });

  server.registerTool(
    "scaffold",
    {
      description:
        "Create a new principle directory that already passes run_cases. Returns the path. Edit principle.md, detector.ts and cases/ from there.",
      inputSchema: {
        slug: z.string().describe("The principle's id, which becomes the directory name: 3 to 64 characters of a-z, 0-9 and dashes, e.g. avoid-late"),
        parent: z.string().describe("Absolute path of the directory to create it in"),
      },
    },
    async ({ slug, parent }) => text(`Created ${scaffold(slug, parent)}\n\n${AUTHORING_GUIDE}`),
  );

  server.registerTool(
    "run_cases",
    {
      description:
        "Build a principle and run every case in the real isolate with the real limits. Reports each case, the publish gates and warnings about the advice text.",
      inputSchema: { dir: z.string().describe("Absolute path of the principle directory") },
    },
    async ({ dir }) => text(renderReport(await testPrinciple(dir))),
  );

  server.registerTool(
    "try",
    {
      description:
        "Show one input to a principle's detector and return the findings and the exact text an agent would be shown. Pass exactly one of file, prompt or command.",
      inputSchema: {
        dir: z.string().describe("Absolute path of the principle directory"),
        file: z.string().optional().describe("Absolute path of a file, treated as just written by the agent"),
        read: z.boolean().optional().describe("Treat the file as read rather than written"),
        prompt: z.string().optional().describe("A user message"),
        command: z.string().optional().describe("A shell command the agent is about to run"),
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
        "Upload a principle to the registry as a private draft. The registry rebuilds it and reruns every case. Returns the URL where the human reviews and releases it. Needs `wellactually login` to have been run once.",
      inputSchema: {
        dir: z.string().describe("Absolute path of the principle directory"),
        note: z.string().optional().describe("One line on what changed and why, like a commit subject. Shown in the principle's history."),
      },
    },
    async ({ dir, note }) => {
      const result = await publishPrinciple(dir, note ?? "");
      const report = renderReport({ id: result.id, title: null, report: result.report });
      if (!result.accepted) {
        return text(`The registry refused the draft.\n\n${report}`);
      }
      return text(`Draft ${result.id} version ${result.version} uploaded.\nA human releases it at ${result.url}\n\n${report}`);
    },
  );

  server.registerTool(
    "pull",
    {
      description:
        "Download an existing principle's files from the registry into a directory, to update it. Returns the user's own draft when one is waiting, including edits made in the browser, otherwise the newest release. Then edit, run_cases and publish_draft.",
      inputSchema: {
        id: z.string().describe("advisor/principle, or just the principle id for one of the user's own. Append @3 for a specific version."),
        dir: z.string().describe("Absolute path of the directory to write the files to"),
        force: z.boolean().optional().describe("Replace the files of a directory that already has some. Discards local edits."),
      },
    },
    async ({ id, dir, force }) => text(renderPull(await pullPrinciple(id, dir, force ?? false))),
  );

  server.registerTool(
    "history",
    {
      description:
        "Show a principle's versions, newest first, like a commit log: version, hash, date, the author's note and which files changed. Includes the user's own unreleased draft.",
      inputSchema: { id: z.string().describe("advisor/principle, or just the principle id for one of the user's own") },
    },
    async ({ id }) => text(renderHistory(await principleHistory(id))),
  );

  server.registerTool(
    "rate_principle",
    {
      description:
        "Tell the author of a principle how its advice went, after it was shown to you in an <wellactually> block. Rate once per principle and task, when you know: after you applied the advice, or decided not to. up: the advice was right here and changed what you did for the better. down: the detector matched the right thing, but the advice was wrong, unclear or made the result worse. not_applicable: the detector fired on something the advice is not about, a false positive. Sends only the principle and the rating, nothing about the code or the conversation.",
      inputSchema: {
        id: z.string().describe('The id from the <principle id="..."> tag, e.g. passsy/avoid-late'),
        rating: z.enum(["up", "down", "not_applicable"]).describe("up, down or not_applicable"),
      },
    },
    async ({ id, rating }) => {
      try {
        return text(await ratePrinciple(id, rating));
      } catch (error) {
        if (error instanceof RegistryError) {
          // A rating is a courtesy. Failing to send one must not derail the agent's task.
          return text(`The rating was not recorded: ${error.message} Carry on with your task.`);
        }
        throw error;
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stay up until the client goes away, then let the process end.
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.on("end", () => resolve());
  });
}
