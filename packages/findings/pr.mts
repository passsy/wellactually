/**
 * Whether the pull request under a review has landed since the review ran.
 *
 * `start_review` records what was true when the run began, which is the one
 * moment a pull request is guaranteed *not* to be merged. The case worth
 * saying — it landed while somebody was reading the review — can only be
 * found out later, so somebody has to look, and the only process that is
 * still around later is this one.
 *
 * Everything here is best effort by construction. A machine may have no `gh`,
 * no network, no account that can see the repository, or a forge that is not
 * GitHub at all — and every one of those has to end in "no answer" rather
 * than in a wrong answer, because the state on disk came from somebody who
 * did know and is better than a guess.
 *
 * Nothing here ever downgrades. A pull request does not un-merge, so the only
 * write this makes is open → merged (or closed), once, ever.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { recordedPr } from "./api.mts";
import { readMeta, writeMeta } from "./store/findings.mts";
import type { TargetPaths } from "./store/paths.mts";
import type { ReviewBranch, ReviewPr } from "./model/types.mts";

const run = promisify(execFile);

/**
 * How long an answer is good for.
 *
 * Held in memory rather than on disk. Stamping the last check into the
 * review's own file would be a write every few minutes per review, and every
 * write under a review directory is a change event and a page refetch — a
 * refresh loop the reader would see, in exchange for remembering something
 * that does not matter across restarts.
 */
const GOOD_FOR = 5 * 60_000;

/** When each review was last asked about, keyed "<repo> <target>". */
const asked = new Map<string, number>();

/**
 * Who can see each owner, keyed "<host>/<owner>".
 *
 * Three answers, and the empty string is the one that matters: it means the
 * account the CLI is already on, which is the whole story on a machine with
 * one account. A login names a second account that had to be reached for, and
 * null means nobody here can see this owner — a client org somebody else's
 * key opens, or a forge that is not GitHub at all.
 *
 * Kept per owner rather than per host, because access is granted per owner. A
 * private repository nobody here can read must not teach this that github.com
 * is unreachable.
 */
const opens = new Map<string, string | null>();

let installed: boolean | null = null;

/** One `gh` invocation, with the identity to run it as, or none for the
 * account the CLI is already on. */
async function gh(args: string[], token?: string): Promise<string | null> {
  try {
    const { stdout } = await run("gh", args, {
      timeout: 8000,
      env: {
        ...process.env,
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_PROMPT_DISABLED: "1",
        ...(token ? { GH_TOKEN: token } : {}),
      },
    });
    return stdout;
  } catch {
    // Not installed, not logged in, no network, no access, or a pull request
    // that is not there. Every one of them means the same thing here.
    return null;
  }
}

async function hasGh(): Promise<boolean> {
  installed ??= (await gh(["--version"])) !== null;
  return installed;
}

/**
 * Every account the CLI is logged in as, for the machines that have more
 * than one.
 *
 * Not consulted at all until an account has actually been refused, because
 * nine machines in ten have exactly one account and on those this whole
 * question never comes up: the first call is made as whoever `gh` is already
 * logged in as, and it answers.
 */
async function logins(): Promise<string[]> {
  const status = await gh(["auth", "status"]);
  if (status === null) return [];
  return [...status.matchAll(/account (\S+)/g)].map((found) => found[1] ?? "");
}

/** A token for one account, without switching the account the CLI is on —
 * which is global, and would move under whoever is using their own terminal. */
async function tokenFor(login: string): Promise<string | null> {
  const token = await gh(["auth", "token", "--user", login]);
  return token === null ? null : token.trim();
}

export interface Remote {
  host: string;
  owner: string;
  name: string;
}

const SCP = /^(?:[^@/]+@)?([^:/]+):(.+?)(?:\.git)?$/;
const SPELLED = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?$/;

/** The forge, the owner and the repository, out of a git remote URL. */
export function parseRemote(url: string): Remote | null {
  const found = SPELLED.exec(url) ?? SCP.exec(url);
  const host = found?.[1];
  const path = found?.[2];
  if (!host || !path) return null;
  const parts = path.split("/").filter(Boolean);
  const name = parts.pop();
  const owner = parts.pop();
  if (!owner || !name) return null;
  return { host, owner, name };
}

/**
 * The host a remote really points at.
 *
 * A URL like "github-work:acme/app.git" names an entry in ~/.ssh/config, not
 * a machine — which is how one person keeps two GitHub identities apart, and
 * how a repository that is plainly on GitHub can look like it is not. Asking
 * ssh to resolve the alias is the only way to tell, and it is what ssh itself
 * would do a moment later.
 */
async function realHost(host: string): Promise<string> {
  if (host.includes(".")) return host;
  try {
    const { stdout } = await run("ssh", ["-G", host], { timeout: 4000 });
    return /^hostname (\S+)$/m.exec(stdout)?.[1] ?? host;
  } catch {
    return host;
  }
}

/** The remote of a checkout: origin when there is one, the first otherwise —
 * a review worktree is as likely to call it "upstream" or the company name. */
async function remoteOf(repo: string): Promise<Remote | null> {
  try {
    const { stdout } = await run("git", ["remote"], {
      cwd: repo,
      timeout: 4000,
    });
    const names = stdout.split("\n").filter(Boolean);
    const name = names.includes("origin") ? "origin" : names[0];
    if (!name) return null;
    const { stdout: url } = await run("git", ["remote", "get-url", name], {
      cwd: repo,
      timeout: 4000,
    });
    const remote = parseRemote(url.trim());
    if (!remote) return null;
    return { ...remote, host: await realHost(remote.host) };
  } catch {
    return null;
  }
}

/** What a forge says about one pull request. */
export interface PrFacts {
  state: string;
  mergedAt?: string;
  mergedBy?: string;
  /** The commit at the head of the branch right now. */
  headSha?: string;
}

interface Answer {
  state?: string;
  mergedAt?: string | null;
  mergedBy?: { login?: string } | null;
  headRefOid?: string | null;
}

function factsFrom(raw: string): PrFacts | null {
  let answer: Answer;
  try {
    answer = JSON.parse(raw) as Answer;
  } catch {
    return null;
  }
  const state = answer.state?.toLowerCase();
  if (!state) return null;
  return {
    state,
    ...(answer.mergedAt ? { mergedAt: answer.mergedAt } : {}),
    ...(answer.mergedBy?.login ? { mergedBy: answer.mergedBy.login } : {}),
    ...(answer.headRefOid ? { headSha: answer.headRefOid } : {}),
  };
}

/**
 * Ask about one pull request, as whoever can see it.
 *
 * The common shape is the whole of it: one call, as the account the CLI is
 * already on. Only when that is refused does this look for other accounts,
 * and the one that answers is remembered per owner — an owner is the unit
 * access is granted in, so the second repository of a client org costs
 * nothing to place.
 *
 * A refusal is never an answer. "Not found" from GitHub means the repository
 * is private *or* absent, and the two are indistinguishable without a key
 * that can see it, so it can only ever mean "ask somebody else".
 */
async function askWith(remote: Remote, args: string[]): Promise<string | null> {
  const key = `${remote.host}/${remote.owner}`;
  const known = opens.get(key);

  // Placed already: nobody, a named account, or the one the CLI is on.
  if (known === null) return null;
  if (known) {
    const token = await tokenFor(known);
    return token === null ? null : await gh(args, token);
  }

  // The account the CLI is on. On a machine with one account this is the only
  // call that ever happens, and the rest of this function is dead weight.
  const said = await gh(args);
  if (said !== null) {
    opens.set(key, "");
    return said;
  }
  // It was on that account and it was refused, so it stays refused.
  if (known === "") return null;

  for (const login of await logins()) {
    const token = await tokenFor(login);
    if (token === null) continue;
    const answered = await gh(args, token);
    if (answered === null) continue;
    opens.set(key, login);
    return answered;
  }
  // Nobody here can see it. Remembered so the next review of the same owner
  // does not walk the whole keyring again.
  opens.set(key, null);
  return null;
}

/** The repository as `--repo` spells it: bare on github.com, host-first
 * anywhere else, which is how one gh reaches an enterprise install. */
function specOf(remote: Remote): string {
  return remote.host === "github.com"
    ? `${remote.owner}/${remote.name}`
    : `${remote.host}/${remote.owner}/${remote.name}`;
}

async function ask(remote: Remote, number: number): Promise<PrFacts | null> {
  const said = await askWith(remote, [
    "pr",
    "view",
    String(number),
    "--repo",
    specOf(remote),
    "--json",
    // The head commit rides along with the state: it is the same call, and
    // without it there is no way to know the branch has moved on.
    "state,mergedAt,mergedBy,headRefOid",
  ]);
  return said === null ? null : factsFrom(said);
}

/** How far a branch has run on since a commit, and whether it still contains
 * that commit at all. */
interface Drift {
  behind: number;
  rewritten: boolean;
}

/**
 * What has happened to the branch since the review looked at it.
 *
 * One call, and only when the two commits differ — which for most reviews of
 * most branches is never. Asked of the forge rather than of the checkout
 * because the checkout is frozen at review time: its idea of the branch is
 * the commit it is sitting on, which is exactly the thing being compared.
 */
async function drift(
  remote: Remote,
  reviewed: string,
  head: string,
): Promise<Drift | null> {
  const said = await askWith(remote, [
    "api",
    ...(remote.host === "github.com" ? [] : ["--hostname", remote.host]),
    `repos/${remote.owner}/${remote.name}/compare/${reviewed}...${head}`,
    "--jq",
    "{ahead:.ahead_by,status:.status}",
  ]);
  if (said === null) return null;
  try {
    const answer = JSON.parse(said) as { ahead?: number; status?: string };
    if (typeof answer.ahead !== "number") return null;
    return { behind: answer.ahead, rewritten: answer.status === "diverged" };
  } catch {
    return null;
  }
}

/**
 * The commit the review was written against.
 *
 * The review worktree is a checkout that nobody works in and nothing moves,
 * so its HEAD is still the commit every finding's line numbers were taken
 * from. No network, and nothing to record — the answer has been sitting on
 * disk since the run.
 */
async function reviewedAt(repo: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      timeout: 4000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The branch a review's own repository treats as the trunk.
 *
 * Asked of the checkout rather than assumed, because "main" is a convention
 * and not a rule, and a machine holding reviews of eight repositories will
 * eventually hold one that says master. `origin/HEAD` is what the clone
 * recorded; the two names are the fallback for a clone that never set it.
 */
async function trunkOf(repo: string): Promise<string | null> {
  try {
    const { stdout } = await run(
      "git",
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { cwd: repo, timeout: 4000 },
    );
    const named = stdout.trim().replace(/^origin\//, "");
    if (named) return named;
  } catch {
    // A clone with no origin/HEAD, which is most clones made by a script.
  }
  for (const name of ["main", "master"]) {
    for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) {
      try {
        await run("git", ["rev-parse", "--verify", "--quiet", ref], {
          cwd: repo,
          timeout: 4000,
        });
        return name;
      } catch {
        // Not this one.
      }
    }
  }
  return null;
}

/**
 * Whether what was reviewed has reached the trunk.
 *
 * The same question a merged pull request answers, for the reviews that are
 * of a branch and nothing else — which nothing on the page could say before,
 * so a review of work that landed a week ago looked exactly like one of work
 * still in progress.
 *
 * Nothing is fetched. The trunk is however current the reader's own checkout
 * is, and a worktree shares its refs with the repository it was made from, so
 * pulling anywhere updates this. Answering "as far as this machine knows" a
 * second after being asked beats answering exactly after going to the network
 * on a timer nobody asked for.
 *
 * Both the local branch and the remote-tracking one count, because either can
 * be the one that is up to date depending on how the reader works.
 */
async function landedIn(
  repo: string,
  reviewed: string,
): Promise<ReviewBranch | null> {
  const base = await trunkOf(repo);
  if (!base) return null;
  for (const ref of [`refs/heads/${base}`, `refs/remotes/origin/${base}`]) {
    try {
      await run("git", ["merge-base", "--is-ancestor", reviewed, ref], {
        cwd: repo,
        timeout: 4000,
      });
      return { base, landed: true, at: new Date().toISOString() };
    } catch {
      // Either the ref is not there or the commit is not in it. The next ref
      // decides, and if neither says yes then it has not landed.
    }
  }
  return { base, landed: false, at: new Date().toISOString() };
}

/** The two states a pull request never leaves. */
function settled(pr: ReviewPr): boolean {
  return pr.state === "merged" || pr.state === "closed";
}

/**
 * Why one look came to nothing, or to something.
 *
 * Every one of these is a thing that legitimately happens on somebody's
 * machine, and told apart because "nothing happened" is the answer a person
 * gets when they press the button and it is the least useful sentence in
 * software. Which nothing it was is the whole of the debugging.
 */
export type Why =
  | "no-pr"
  | "settled"
  | "fresh"
  | "no-gh"
  | "no-remote"
  | "no-answer"
  | "unchanged"
  | "changed";

export interface Look {
  why: Why;
  /** What the forge said, when it said anything. */
  state?: string;
}

/** Nothing was asked of anybody, so nothing was spent. */
function free(why: Why): boolean {
  return why === "no-pr" || why === "settled" || why === "fresh";
}

/**
 * Look once, and write only if the answer is both conclusive and new.
 *
 * The write is the notification: every file under a review directory is
 * watched, so putting the new state in the review's own meta is what reaches
 * the open page. Nothing else has to be told.
 *
 * `now` is a person pressing the button: it forgets how recently this was
 * asked, because somebody watching the screen has better reason to think the
 * answer has changed than a clock does. It does not forget that a merged pull
 * request is merged — that one cannot change.
 */
export async function refreshPr(
  paths: TargetPaths,
  now = false,
): Promise<Look> {
  const key = `${paths.repo} ${paths.target}`;
  const last = asked.get(key) ?? 0;
  if (!now && Date.now() - last < GOOD_FOR) return { why: "fresh" };

  const meta = readMeta(paths);
  // Not `meta.pr`: a review that ran before there was a tool to record any of
  // this keeps its pull request in the README, and reading only the meta
  // would call those reviews "no pull request" forever.
  const pr = recordedPr(paths, meta);
  if (!pr.number) {
    // Not nothing, just nothing to ask a forge. Git can still say whether the
    // work landed, on this machine, without a network — so a review of a
    // branch is not left as the one kind with nothing on it at all.
    asked.set(key, Date.now());
    const reviewed = await reviewedAt(paths.repo);
    const branch = reviewed ? await landedIn(paths.repo, reviewed) : null;
    if (!branch) return { why: "no-pr" };
    if (
      JSON.stringify({ ...branch, at: "" }) ===
      JSON.stringify({ ...(meta.branch ?? {}), at: "" })
    )
      return { why: "unchanged" };
    writeMeta(paths, { ...meta, branch });
    return { why: "changed", state: branch.landed ? "landed" : "open" };
  }
  if (settled(pr))
    return { why: "settled", ...(pr.state ? { state: pr.state } : {}) };
  asked.set(key, Date.now());

  if (!(await hasGh())) return { why: "no-gh" };
  const remote = await remoteOf(paths.repo);
  if (!remote) return { why: "no-remote" };

  const facts = await ask(remote, pr.number);
  if (!facts) return { why: "no-answer" };

  // How far the branch has run on since the run. Only worth a call when the
  // two commits actually differ, which for most reviews is never.
  const reviewed = await reviewedAt(paths.repo);
  let moved: Drift | null = null;
  if (reviewed && facts.headSha) {
    moved =
      reviewed === facts.headSha
        ? { behind: 0, rewritten: false }
        : await drift(remote, reviewed, facts.headSha);
  }

  const next: ReviewPr = {
    ...pr,
    state: facts.state,
    ...(facts.mergedAt ? { mergedAt: facts.mergedAt } : {}),
    ...(facts.mergedBy ? { mergedBy: facts.mergedBy } : {}),
    ...(facts.headSha ? { headSha: facts.headSha } : {}),
    ...(moved ? { behind: moved.behind, rewritten: moved.rewritten } : {}),
  };
  // Every field, not just the state: a branch gaining commits moves nothing
  // else, and it is the thing this was asked about.
  if (JSON.stringify(next) === JSON.stringify(pr))
    return { why: "unchanged", state: facts.state };

  writeMeta(paths, { ...meta, pr: next });
  return { why: "changed", state: facts.state };
}

/**
 * The same, for several reviews, one after another and never all at once.
 *
 * A machine holding twenty reviews would otherwise open twenty connections
 * the moment the list is drawn. Settled ones cost nothing and do not count
 * against the budget; the rest come round on the next pass.
 */
export async function refreshSome(
  every: TargetPaths[],
  most = 4,
): Promise<void> {
  let spent = 0;
  for (const paths of every) {
    if (spent >= most) return;
    const look = await refreshPr(paths);
    if (!free(look.why)) spent += 1;
  }
}

/** One review's answer, said in full, for whoever asked for it by hand. */
export interface Told extends Look {
  repo: string;
  target: string;
}

/**
 * Every review, asked now, and every answer reported.
 *
 * The hand-driven twin of the sweep. Uncapped and un-TTLed on purpose: a
 * person pressing a button is not a timer, they are waiting for it, and what
 * they get back has to be the whole account of what happened — including for
 * the reviews where the answer was that nothing could be asked.
 */
export async function refreshAll(every: TargetPaths[]): Promise<Told[]> {
  const told: Told[] = [];
  for (const paths of every) {
    told.push({
      repo: paths.repo,
      target: paths.target,
      ...(await refreshPr(paths, true)),
    });
  }
  return told;
}

/**
 * How often the reviews on the machine are asked about while nobody is
 * asking for them.
 *
 * The case this exists for is a review left pending for hours and then opened
 * cold: by then the answer should already be on the page rather than arriving
 * a second after it is drawn, because the first thing a reader does with a
 * merged pull request is decide whether to read the review at all. Ten
 * minutes is far finer than the thing being watched — a pull request lands
 * once and stays landed — and coarse enough that a laptop asleep on a desk is
 * not talking to a forge.
 */
const SWEEP = 10 * 60_000;

/**
 * Keep every unsettled review current for as long as this server serves the
 * page.
 *
 * Tied to the page rather than to the process: whichever server holds the
 * port is the one whose answers a reader can see, and a server that has
 * handed the port to a newer install has no business keeping a forge awake.
 * The timer is unrefed, so this never keeps a session alive on its own.
 */
export function sweepPrs(reviews: () => TargetPaths[]): () => void {
  const beat = () => {
    void refreshSome(reviews(), 24);
  };
  const timer = setInterval(beat, SWEEP);
  timer.unref?.();
  // Once at the start too: a server that has just taken the port may have
  // been handed reviews that went stale while nothing was serving them.
  beat();
  return () => {
    clearInterval(timer);
  };
}
