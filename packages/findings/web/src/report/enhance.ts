/**
 * The half of the report that only works when a server is listening.
 *
 * The report is a document first. Node renders every finding into markup at
 * write time, so the file is complete before this runs and stays complete if
 * it never does — which is the normal case, because the file it lives in gets
 * opened from a downloads folder on a machine with none of this installed.
 *
 * So this adds and never replaces: it reveals the buttons that can now do
 * something, gives rule references a destination, and posts a verdict when
 * one is pressed. No React reaches this file. React renders it, on the other
 * side, at write time — a hydration bundle is half a megabyte and a real
 * review.html is six kilobytes, and the point of the file is that you can
 * send it to somebody.
 */

import "../styles/report.css";

interface ReportContext {
  repo: string;
  target: string;
  port: number;
}

const payload = document.getElementById("report-data")?.textContent;
const context = payload ? (JSON.parse(payload) as ReportContext) : null;

/**
 * A document link points at a file sitting right beside this one, so the path
 * the markdown already carries is the right one. Done without asking the
 * server anything, because it holds with no server running, which is the case
 * this report exists for.
 */
for (const link of document.querySelectorAll<HTMLAnchorElement>(
  "a.docref[data-doc]",
)) {
  const doc = link.dataset["doc"];
  if (doc) link.href = doc;
}

function say(message: string): void {
  const live = document.getElementById("live");
  if (live) live.textContent = message;
}

async function connect(where: string): Promise<boolean> {
  try {
    const response = await fetch(`${where}/api/health`, { mode: "cors" });
    return response.ok;
  } catch {
    return false;
  }
}

async function wake(): Promise<void> {
  if (!context) return;
  const api = `http://127.0.0.1:${context.port}`;
  if (!(await connect(api))) return;

  say("Triage server connected. These buttons write straight to disk.");

  // Only now. A rule reference is rendered as an anchor with no destination,
  // because until this point there is nothing to send it to, and a link that
  // goes nowhere is worse than plain text saying the same thing.
  for (const rule of document.querySelectorAll<HTMLAnchorElement>(
    "a.rule[data-rule]",
  )) {
    const id = rule.dataset["rule"];
    if (!id) continue;
    rule.href = `${api}/rule/${encodeURIComponent(id)}`;
    rule.target = "_blank";
    rule.rel = "noopener";
  }

  for (const actions of document.querySelectorAll<HTMLElement>(".actions")) {
    const finding = actions.closest<HTMLElement>(".finding");
    if (!finding) continue;
    // Only what this finding can still move on: no Accept on something
    // already accepted, no Resolved on something already gone.
    for (const button of actions.querySelectorAll<HTMLButtonElement>(
      "button[data-axis]",
    )) {
      const axis = button.dataset["axis"];
      button.hidden = axis
        ? finding.dataset[axis] === button.dataset["act"]
        : false;
    }
    actions.hidden = false;
  }

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>("button[data-act]");
    if (!button) return;
    void press(api, button);
  });
}

async function press(api: string, button: HTMLButtonElement): Promise<void> {
  if (!context) return;
  const to = button.dataset["act"];
  const axis = button.dataset["axis"];
  const id = button.dataset["id"];
  if (!to || !axis || !id) return;

  try {
    const response = await fetch(
      `${api}/api/findings/${encodeURIComponent(id)}/${axis}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo: context.repo,
          target: context.target,
          to,
          actor: "human",
        }),
      },
    );
    if (!response.ok) throw new Error(await response.text());
    location.reload();
  } catch (error) {
    // The triage server can stop while this page stays open. A button that
    // silently does nothing is worse than one that says why.
    say(
      `Could not update: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

void wake();
