import fs from "node:fs";
import path from "node:path";
import { boardHome, readConfig, readLockfile } from "../board/board.ts";
import { type HookLogEntry } from "../hook/hook-log.ts";
import { CLIENT_VERSION } from "../update.ts";
import { type AgentSetup, claudeSetup, codexSetup, opencodeNamesPlugin, opencodeSetup } from "./setup.ts";
import { type AuditAgent, type Conversation, type RatingCall, recentClaudeConversations, recentCodexConversations, recentOpencodeConversations } from "./transcripts.ts";

/**
 * Looks back at the user's recent agent sessions and says, for each, whether
 * the hooks ran, which detectors fired, what advice reached the agent and
 * whether it rated that advice. Where something did not happen, it says why
 * as far as the files on this machine tell.
 *
 * It reads the hook log and the agents' own conversation files, and sends nothing anywhere.
 */
export interface AuditOptions {
  /** How far back to look. */
  hours: number;
  agent?: AuditAgent;
  /** Only the session whose id starts with this. */
  session?: string;
  /** The folder the audit runs in, for the project's own opencode.json. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
}

/** What the hook log says about one session. */
export interface HookSummary {
  /** Hook calls by their name, such as PostToolUse. */
  calls: Record<string, number>;
  /** Calls that gave the agent advice. */
  shown: number;
  /** Detectors that found something, with how many events they fired on. */
  fired: Record<string, number>;
  /** The conversation file the agent named, if any call named one. */
  transcript: string | null;
  /** Why calls ran no detector, with how often. */
  notes: Record<string, number>;
  /** Principles that did not run, with the reason, such as off. */
  skipped: Record<string, string>;
  /** Detectors that failed, with their error. */
  errors: Record<string, string>;
  first: string;
  last: string;
}

export interface AuditedSession {
  agent: AuditAgent;
  session: string;
  cwd: string | null;
  started: string | null;
  updated: string;
  model: string | null;
  source: string | null;
  hooks: HookSummary | null;
  conversation: Conversation | null;
  /** What happened and what did not, in plain sentences. */
  findings: string[];
}

export interface AuditReport {
  version: string;
  since: string;
  home: string;
  signedIn: boolean;
  stats: boolean;
  board: { principles: number; enabled: number; syncedAt: string | null };
  log: { on: boolean; files: number; from: string | null };
  offProjects: string[];
  offPrinciples: string[];
  hookCrashes: string[];
  setups: AgentSetup[];
  /** Per agent: its sessions, those where advice reached it, and those of them it rated in. */
  summary: { agent: AuditAgent; sessions: number; advised: number; rated: number; ratings: number }[];
  /** Agents whose conversations could not be read, with why. */
  unreadable: string[];
  sessions: AuditedSession[];
}

const RATE_HINT = "Rating is up to the agent, which is asked to rate once it knows how the advice went. Agents often leave it out.";

export async function audit(options: AuditOptions): Promise<AuditReport> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const since = now - options.hours * 60 * 60 * 1000;
  const home = boardHome();
  const config = readConfig();
  const lockfile = readLockfile();

  const { entries, files, from } = readHookLog(path.join(home, "logs"), since);
  const unreadable: string[] = [];
  const conversations: Conversation[] = [];
  const wants = (agent: AuditAgent): boolean => options.agent === undefined || options.agent === agent;
  if (wants("claude-code")) {
    conversations.push(...recentClaudeConversations(since, env));
  }
  if (wants("codex")) {
    conversations.push(...recentCodexConversations(since, env));
  }
  if (wants("opencode")) {
    try {
      const opencode = await recentOpencodeConversations(since, env);
      if (opencode === null) {
        unreadable.push("OpenCode: its sessions are in a SQLite database, which this Node cannot open. Node 22.5 or newer can.");
      } else {
        conversations.push(...opencode);
      }
    } catch (error) {
      unreadable.push(`OpenCode: could not read its database: ${(error as Error).message}`);
    }
  }

  // Every session either side knows of: the hook log's and the conversations'.
  // A subagent's conversation counts towards the session that started it, under which its hooks ran.
  const byId = new Map<string, AuditedSession>();
  const own = conversations.filter((conversation) => conversation.parent === null);
  const subagents = conversations.filter((conversation) => conversation.parent !== null);
  for (const conversation of [...own, ...subagents]) {
    const id = conversation.parent ?? conversation.session;
    const known = byId.get(id);
    if (known?.conversation) {
      mergeInto(known.conversation, conversation);
      if (conversation.updated > known.updated) {
        known.updated = conversation.updated;
      }
      continue;
    }
    byId.set(id, {
      agent: conversation.agent,
      session: id,
      cwd: conversation.cwd,
      started: conversation.started,
      updated: conversation.updated,
      model: conversation.model,
      source: conversation.source,
      hooks: null,
      conversation: { ...conversation, session: id, parent: null },
      findings: [],
    });
  }
  for (const entry of entries) {
    if (!entry.session) {
      continue;
    }
    let session = byId.get(entry.session);
    if (!session) {
      const agent = agentOfEntry(entry);
      if (!wants(agent)) {
        continue;
      }
      session = { agent, session: entry.session, cwd: entry.cwd ?? null, started: null, updated: entry.time, model: null, source: entry.transcript ?? null, hooks: null, conversation: null, findings: [] };
      byId.set(entry.session, session);
    }
    session.hooks = addEntry(session.hooks, entry);
    if (entry.time > session.updated) {
      session.updated = entry.time;
    }
  }

  const setups = [claudeSetup(env), codexSetup(env), opencodeSetup(env, options.cwd)].filter((setup) => setup.present && (options.agent === undefined || setup.agent === options.agent));
  const logOn = env.WELLACTUALLY_HOOK_LOG !== "0";
  const sessions = [...byId.values()]
    .filter((session) => !options.session || session.session.startsWith(options.session))
    .filter((session) => session.hooks !== null || isRelevant(session.conversation))
    .sort((a, b) => b.updated.localeCompare(a.updated));
  for (const session of sessions) {
    session.findings = explain(session, { env, logFrom: from, logOn, setups, boardSize: lockfile.entries.length, stats: config.stats });
  }

  return {
    version: CLIENT_VERSION,
    since: new Date(since).toISOString(),
    home,
    signedIn: Boolean(config.token),
    stats: config.stats,
    board: { principles: lockfile.entries.length, enabled: lockfile.entries.filter((entry) => entry.enabled).length, syncedAt: lockfile.syncedAt ?? null },
    log: { on: logOn, files, from },
    offProjects: readList(path.join(home, "disabled.json"), "projects"),
    offPrinciples: readList(path.join(home, "disabled.json"), "disabled"),
    hookCrashes: hookCrashes(path.join(home, "hook.log"), since),
    setups,
    summary: summarize(sessions),
    unreadable,
    sessions,
  };
}

function summarize(sessions: AuditedSession[]): AuditReport["summary"] {
  const summary: AuditReport["summary"] = [];
  for (const session of sessions) {
    let line = summary.find((candidate) => candidate.agent === session.agent);
    if (!line) {
      line = { agent: session.agent, sessions: 0, advised: 0, rated: 0, ratings: 0 };
      summary.push(line);
    }
    line.sessions++;
    const ratings = session.conversation?.ratings.length ?? 0;
    line.ratings += ratings;
    if ((session.conversation?.advice ?? 0) > 0) {
      line.advised++;
      if (ratings > 0) {
        line.rated++;
      }
    }
  }
  return summary;
}

function mergeInto(into: Conversation, from: Conversation): void {
  into.advice += from.advice;
  into.cut += from.cut;
  into.asked += from.asked;
  for (const [id, count] of Object.entries(from.principles)) {
    into.principles[id] = (into.principles[id] ?? 0) + count;
  }
  into.ratings.push(...from.ratings);
  into.rateTool = into.rateTool === true || from.rateTool === true ? true : (into.rateTool ?? from.rateTool);
  into.plugin = into.plugin === true || from.plugin === true ? true : (into.plugin ?? from.plugin);
  into.hookFailures.push(...from.hookFailures);
  if (from.hookRuns !== null) {
    into.hookRuns = (into.hookRuns ?? 0) + from.hookRuns;
  }
}

/**
 * A conversation worth reporting without a line in the hook log: one in a
 * folder the hooks would have run in. A session that never started a turn
 * tells nothing.
 */
function isRelevant(conversation: Conversation | null): boolean {
  if (!conversation) {
    return false;
  }
  return conversation.advice > 0 || conversation.ratings.length > 0 || (conversation.hookRuns ?? 0) > 0 || conversation.started !== null;
}

function agentOfEntry(entry: HookLogEntry): AuditAgent {
  const transcript = entry.transcript ?? "";
  if (/[\\/]\.codex[\\/]/.test(transcript)) {
    return "codex";
  }
  if (/[\\/]\.pi[\\/]/.test(transcript)) {
    return "pi";
  }
  if ((entry.session ?? "").startsWith("ses_")) {
    return "opencode";
  }
  if (transcript === "" && /^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(entry.session ?? "")) {
    // Codex names its sessions with time-ordered UUIDs, and some of its hooks name no transcript.
    return "codex";
  }
  return "claude-code";
}

function readHookLog(dir: string, since: number): { entries: HookLogEntry[]; files: number; from: string | null } {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => /^hooks-.*\.jsonl$/.test(name)).sort();
  } catch {
    return { entries: [], files: 0, from: null };
  }
  const entries: HookLogEntry[] = [];
  let from: string | null = null;
  for (const name of names) {
    const hour = /^hooks-(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl$/.exec(name)?.[1];
    if (hour && from === null) {
      from = `${hour}:00:00.000Z`;
    }
    if (hour && Date.parse(`${hour}:59:59.999Z`) < since) {
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line) as HookLogEntry;
        if (Date.parse(entry.time) >= since) {
          entries.push(entry);
        }
      } catch {
        // A line cut off by the size limit.
      }
    }
  }
  return { entries, files: names.length, from };
}

function addEntry(summary: HookSummary | null, entry: HookLogEntry): HookSummary {
  const into = summary ?? { calls: {}, shown: 0, transcript: null, fired: {}, notes: {}, skipped: {}, errors: {}, first: entry.time, last: entry.time };
  into.calls[entry.hook] = (into.calls[entry.hook] ?? 0) + 1;
  into.transcript ??= entry.transcript ?? null;
  if (entry.shown > 0) {
    into.shown++;
  }
  if (entry.note) {
    into.notes[entry.note] = (into.notes[entry.note] ?? 0) + 1;
  }
  for (const event of entry.events ?? []) {
    for (const detector of event.detectors ?? []) {
      if ((detector.findings ?? []).length > 0) {
        into.fired[detector.id] = (into.fired[detector.id] ?? 0) + 1;
      }
      if (detector.error || detector.thrown) {
        into.errors[detector.id] = detector.error ?? detector.thrown ?? "";
      }
    }
    for (const skipped of event.skipped ?? []) {
      into.skipped[skipped.id] = skipped.reason;
    }
  }
  if (entry.time < into.first) {
    into.first = entry.time;
  }
  if (entry.time > into.last) {
    into.last = entry.time;
  }
  return into;
}

interface Context {
  env: NodeJS.ProcessEnv;
  logFrom: string | null;
  logOn: boolean;
  setups: AgentSetup[];
  boardSize: number;
  stats: boolean;
}

/** What happened in a session and, where something did not, the likeliest reason. */
export function explain(session: AuditedSession, context: Context): string[] {
  const findings: string[] = [];
  const hooks = session.hooks;
  const conversation = session.conversation;
  const setup = context.setups.find((candidate) => candidate.agent === session.agent);

  if (hooks) {
    const calls = Object.values(hooks.calls).reduce((sum, count) => sum + count, 0);
    findings.push(`The hooks ran ${times(calls)}: ${Object.entries(hooks.calls).map(([hook, count]) => `${hook} ${count}`).join(", ")}.`);
  } else if (conversation?.hookRuns) {
    findings.push(`Claude Code ran the plugin's hooks ${times(conversation.hookRuns)}, but the hook log has no line for this session${context.logOn ? ", so it was likely turned off with WELLACTUALLY_HOOK_LOG=0 where the agent ran" : ", because WELLACTUALLY_HOOK_LOG=0 turns it off"}.`);
  } else if (conversation && conversation.advice > 0) {
    findings.push("The hooks ran, since advice reached the agent, but the hook log has no line for this session. They wrote to the log of another WELLACTUALLY_HOME, or the log was turned off with WELLACTUALLY_HOOK_LOG=0 where the agent ran.");
  } else if (context.logFrom && session.started && session.started < context.logFrom && session.updated < context.logFrom) {
    findings.push("The hook log does not reach back to this session, it keeps one day.");
  } else {
    findings.push(`The hooks did not run in this session. ${whyNoHooks(session, setup, context)}`);
  }
  if (!conversation && hooks && session.agent !== "opencode") {
    findings.push(
      hooks.transcript
        ? `Its conversation file ${fs.existsSync(hooks.transcript) ? "has nothing from this time" : "is gone"}, so what the agent read and rated is not known.`
        : "The agent kept no conversation file for it, as for a short background session, so what it read and rated is not known.",
    );
  }
  if (conversation && conversation.hookFailures.length > 0) {
    findings.push(`${conversation.hookFailures.length === 1 ? "One hook run" : `${conversation.hookFailures.length} hook runs`} failed, the first: ${conversation.hookFailures[0]}`);
  }

  if (hooks) {
    const fired = Object.entries(hooks.fired);
    if (fired.length > 0) {
      findings.push(`Detectors fired: ${fired.map(([id, count]) => `${id} (${count})`).join(", ")}.`);
    } else if (Object.keys(hooks.calls).some((hook) => hook !== "SessionStart" && hook !== "SessionEnd" && hook !== "PostCompact")) {
      const reasons = Object.entries(hooks.notes).filter(([note]) => !note.startsWith("started the background sync") && !note.startsWith("forgot") && !note.startsWith("noted the model"));
      findings.push(
        reasons.length > 0
          ? `No detector fired. The hook said: ${reasons.map(([note, count]) => `${note} (${count})`).join("; ")}.`
          : "No detector fired: the detectors ran on what the agent did and found nothing they are about.",
      );
    }
    const errors = Object.entries(hooks.errors);
    if (errors.length > 0) {
      findings.push(`Detectors that failed: ${errors.map(([id, error]) => `${id}: ${error}`).join("; ")}.`);
    }
    const budget = Object.keys(hooks.notes).find((note) => note.startsWith("left out"));
    if (budget) {
      findings.push(`Some advice was left out to stay within the size the agent shows in full: ${budget}.`);
    }
  }

  const advice = conversation ? conversation.advice : hooks ? hooks.shown : 0;
  const principles = conversation ? Object.keys(conversation.principles) : [];
  if (conversation && conversation.advice > 0) {
    findings.push(`Advice reached the agent ${times(conversation.advice)}${principles.length > 0 ? `, from ${principles.join(", ")}` : ""}.`);
  } else if (!conversation && hooks && hooks.shown > 0) {
    findings.push(`The hook gave the agent advice ${times(hooks.shown)}. Its conversation was not found, so what it read is not known.`);
  } else if (conversation && hooks && hooks.shown > 0) {
    findings.push(`The hook gave advice ${times(hooks.shown)}, but none of it is in the conversation. The agent did not show it to the model.`);
  } else if (hooks && Object.keys(hooks.fired).length > 0) {
    findings.push("No advice reached the agent: what fired had been shown in this session before, or the agent did not take the hook's answer.");
  }
  if (conversation && conversation.cut > 0) {
    findings.push(`${conversation.cut === 1 ? "One block of advice was" : `${conversation.cut} blocks of advice were`} cut off before their end by the agent, so the model did not read all of them.`);
  }

  const ratings = conversation?.ratings ?? [];
  if (ratings.length > 0) {
    findings.push(`The agent rated ${times(ratings.length)}: ${ratings.map(describeRating).join("; ")}.`);
    const unrecorded = ratings.filter((rating) => rating.recorded === false);
    if (unrecorded.length > 0) {
      findings.push(`${unrecorded.length === 1 ? "One rating was" : `${unrecorded.length} ratings were`} not recorded. The server said: ${unrecorded[0]?.reply ?? "nothing"}`);
    }
    const unrated = principles.filter((id) => !ratings.some((rating) => rating.id === id));
    if (unrated.length > 0) {
      findings.push(`Not rated: ${unrated.join(", ")}.`);
    }
  } else if (advice > 0 && conversation) {
    findings.push(`The agent rated none of the advice. ${whyNoRating(session, context)}`);
  }
  return findings;
}

function times(count: number): string {
  return count === 1 ? "once" : `${count} times`;
}

function describeRating(rating: RatingCall): string {
  const outcome = rating.recorded === true ? "recorded" : rating.recorded === false ? "not recorded" : "no answer recorded";
  return `${rating.id ?? "?"} ${rating.rating ?? "?"} (${outcome})`;
}

function whyNoHooks(session: AuditedSession, setup: AgentSetup | undefined, context: Context): string {
  if (!context.logOn) {
    return "The hook log is turned off with WELLACTUALLY_HOOK_LOG=0, so this is not known for sure.";
  }
  if (session.agent === "codex" && session.conversation?.plugin === false) {
    return "Codex did not load the plugin in this session: it was not installed or was switched off.";
  }
  if (session.agent === "opencode") {
    if (session.cwd && !fs.existsSync(session.cwd) && !opencodeNamesPlugin(context.env, session.cwd)) {
      return "Its folder is gone, so whether an opencode.json there named the plugin is not known. The global one does not.";
    }
    if (session.cwd && !opencodeNamesPlugin(context.env, session.cwd)) {
      return "No opencode.json names the plugin, neither the global one nor the project's, so OpenCode did not load it.";
    }
    return "The plugin is in opencode.json, so OpenCode likely could not start it: it starts the hook with `node`, which needs Node 20 or newer on the PATH. It also ran the hooks with another WELLACTUALLY_HOME when one was set for it.";
  }
  if (setup?.enabled === false) {
    return setup.notes[0] ?? "The plugin is not enabled.";
  }
  if (session.agent === "codex" && setup?.untrusted && setup.untrusted.length > 0) {
    return `Codex runs a plugin's hooks only once they are trusted in \`/hooks\`, and ${setup.untrusted.join(", ")} are not.`;
  }
  if (session.agent === "codex") {
    return "The hooks are trusted now, so they were likely not yet when this session ran, or the session ran before the plugin was installed. Codex also asks again after an update changed a hook.";
  }
  return "The plugin may have been installed or enabled after this session started. A running session picks up a new plugin only after a restart.";
}

function whyNoRating(session: AuditedSession, context: Context): string {
  const principles = Object.keys(session.conversation?.principles ?? {});
  if (principles.length > 0 && principles.every((id) => id.startsWith("local/"))) {
    return "All of it came from local principles, which belong to no registry, so the agent is not asked to rate them.";
  }
  if (session.conversation && session.conversation.asked === 0) {
    return "None of the advice it read asked it to rate, so the request was cut off or left out.";
  }
  if (session.conversation?.rateTool === false) {
    return `rate_principle was not among the agent's tools, so it could not rate. ${RATE_HINT}`;
  }
  if (session.agent === "codex" && session.conversation?.plugin === false) {
    return "Codex did not load the plugin, so its MCP server and rate_principle were missing.";
  }
  if (!context.stats) {
    return `Reporting is turned off on this machine, so even a rating would not have been sent. ${RATE_HINT}`;
  }
  return RATE_HINT;
}

function readList(file: string, key: string): string[] {
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(json) ? json : json?.[key];
    return Array.isArray(list) ? list.filter((item: unknown) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** The lines of the hook's crash log written since `since`. */
function hookCrashes(file: string, since: number): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => /^\d{4}-\d{2}-\d{2}T/.test(line) && Date.parse(line.slice(0, 24)) >= since)
    .map((line) => (line.length > 300 ? `${line.slice(0, 300)}…` : line));
}

function isQuiet(session: AuditedSession): boolean {
  return session.hooks !== null && Object.keys(session.hooks.fired).length === 0 && session.hooks.shown === 0 && (session.conversation?.advice ?? 0) === 0 && (session.conversation?.ratings.length ?? 0) === 0 && Object.keys(session.hooks.errors).length === 0;
}

const AGENT_NAMES: Record<AuditAgent, string> = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", pi: "pi" };

/** The report as text, the newest sessions first, at most `limit` of them. */
export function renderAudit(report: AuditReport, limit = 15): string {
  const lines: string[] = [];
  lines.push(`Well Actually ${report.version}, looking back to ${report.since}.`);
  lines.push(
    `Advisory board: ${report.board.principles} principles, ${report.board.enabled} enabled${report.board.syncedAt ? `, last synced ${report.board.syncedAt}` : ", never synced"}. ${report.signedIn ? "Signed in." : "Not signed in, so nothing syncs and no rating is sent."}${report.stats ? "" : " Reporting is off, so ratings are not sent."}`,
  );
  lines.push(report.log.on ? (report.log.files > 0 ? `Hook log: ${report.log.files} files in ${report.home}/logs, from ${report.log.from}.` : `Hook log: empty, no hook has run in the last day.`) : "Hook log: turned off with WELLACTUALLY_HOOK_LOG=0 in this shell.");
  if (report.offProjects.length > 0) {
    lines.push(`Switched off in: ${report.offProjects.join(", ")}.`);
  }
  if (report.offPrinciples.length > 0) {
    lines.push(`Principles switched off everywhere: ${report.offPrinciples.join(", ")}.`);
  }
  if (report.hookCrashes.length > 0) {
    lines.push(`The hook crashed ${times(report.hookCrashes.length)}, the last: ${report.hookCrashes[report.hookCrashes.length - 1]}`);
  }
  for (const setup of report.setups) {
    const state = setup.enabled === null ? "unknown" : setup.enabled ? "installed and enabled" : "not enabled";
    const trust = setup.trusted ? `, hooks trusted: ${setup.trusted.length === 0 ? "none" : setup.trusted.join(", ")}` : "";
    lines.push(`${AGENT_NAMES[setup.agent]}: plugin ${state}${setup.version ? ` (${setup.version})` : ""}${trust}.${setup.notes.length > 0 ? ` ${setup.notes.join(" ")}` : ""}`);
  }
  for (const note of report.unreadable) {
    lines.push(note);
  }
  for (const line of report.summary) {
    lines.push(
      `${AGENT_NAMES[line.agent]}: ${line.sessions === 1 ? "one session" : `${line.sessions} sessions`}, advice reached the agent in ${line.advised}${line.advised > 0 ? `, and it rated in ${line.rated} of them` : ""}.`,
    );
  }
  lines.push("");
  // A session where the hooks ran and nothing fired says nothing more than that, so those are only counted.
  const quiet = report.sessions.filter(isQuiet);
  const shown = report.sessions.filter((session) => !isQuiet(session));
  if (report.sessions.length === 0) {
    lines.push("No session in this time.");
  }
  for (const session of shown.slice(0, limit)) {
    const where = session.cwd ? ` in ${session.cwd}` : "";
    lines.push(`${AGENT_NAMES[session.agent]} ${session.session}${where}, last active ${session.updated}${session.model ? `, ${session.model}` : ""}`);
    if (session.source) {
      lines.push(`  ${session.source}`);
    }
    for (const finding of session.findings) {
      lines.push(`  - ${finding}`);
    }
    lines.push("");
  }
  if (shown.length > limit) {
    lines.push(`And ${shown.length - limit} older sessions like these. --session <id> shows one, --json all.`);
  }
  if (quiet.length > 0) {
    const more = shown.length > 0 ? " more" : "";
    lines.push(`In ${quiet.length === 1 ? `one${more} session` : `${quiet.length}${more} sessions`} the hooks ran and no detector fired.`);
  }
  return lines.join("\n").trimEnd();
}
