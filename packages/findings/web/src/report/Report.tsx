/**
 * The generated report: the same components as the triage page, rendered by
 * Node when a finding is written.
 *
 * Static markup, not a hydration root. This file is opened from a downloads
 * folder as often as from the server, and there it has no findings server to
 * talk to and no React to run. So everything a reader needs is markup, and
 * `enhance.ts` only adds what needs a live server — which is why the actions
 * ship hidden and are revealed by script rather than the other way round.
 *
 * One implementation, two runtimes. The old page shipped these renderers to
 * the browser by calling `fn.toString()` on them; sharing a module is the
 * thing that replaces that.
 */

import { Markdown, MarkdownSurface } from "../shared/markdown/Markdown.tsx";
import { Chunks } from "../shared/chunk/Chunk.tsx";
import { Evidence, Priority, Rule, State, Tag } from "../shared/chips.tsx";
import { VerificationNotice } from "../shared/VerificationNotice.tsx";
import {
  AUTHORSHIP_SAYS,
  GROUP_ORDER,
  GROUP_TITLES,
  groupOf,
  type Finding,
} from "../shared/domain.ts";

export interface ReportData {
  target: string;
  repo: string;
  generatedAt: string;
  findings: Finding[];
}

/** The line under a finding's labels, when there is something to say. */
function Notes({ finding }: { finding: Finding }) {
  const failed = finding.history.findLast((entry) => entry.verdict);
  const commit = finding.links.fixCommit;
  return (
    <>
      <VerificationNotice finding={finding} />
      {finding.staleAnchor && (
        <p className="meta stale">
          The last review run did not find this again. The code under it moved.
        </p>
      )}
      {finding.authorship && AUTHORSHIP_SAYS[finding.authorship] && (
        <p className="meta stale">{AUTHORSHIP_SAYS[finding.authorship]}</p>
      )}
      {finding.provenTest && (
        <p className="meta">
          Failing test: <code>{finding.provenTest}</code>
        </p>
      )}
      {finding.reportedAt && (
        <p className="meta">
          Reported {finding.reportedAt.slice(0, 10)}
          {finding.links.prComment ? (
            <>
              {" at "}
              <a href={finding.links.prComment} target="_blank" rel="noopener">
                {finding.links.prComment}
              </a>
            </>
          ) : null}
        </p>
      )}
      {commit ? (
        <p className="meta">
          Fixed by <code>{commit.slice(0, 12)}</code>
          {finding.confirmedAt
            ? ", and a later review run no longer finds it"
            : ""}
        </p>
      ) : finding.confirmedAt ? (
        <p className="meta">A later review run no longer finds it.</p>
      ) : null}
      {(finding.verdict === "invalid" || finding.verdict === "tolerated") && (
        <p className="meta">
          <strong>
            {finding.verdict === "invalid" ? "Invalid" : "Tolerated"}
          </strong>
          {failed?.note ? `: ${failed.note}` : ""}
          {finding.verdict === "invalid" &&
            (finding.links.ruleIssue ? (
              <>
                {" · reported at "}
                <a
                  href={finding.links.ruleIssue}
                  target="_blank"
                  rel="noopener"
                >
                  {finding.links.ruleIssue}
                </a>
              </>
            ) : (
              " · rule issue not filed yet"
            ))}
        </p>
      )}
    </>
  );
}

function One({ finding }: { finding: Finding }) {
  const span =
    (finding.anchor.endLine ?? finding.anchor.line) > finding.anchor.line
      ? `-${String(finding.anchor.endLine)}`
      : "";
  return (
    <article
      className="finding"
      data-id={finding.id}
      data-verdict={finding.verdict}
      data-resolution={finding.resolution}
    >
      <h3>
        <span className="id">{finding.id}</span> {finding.title}
      </h3>
      <p className="tags">
        <Priority of={finding.priority} />
        <Evidence of={finding.evidence} />
        {(finding.tags ?? []).map((tag) => (
          <Tag key={tag}>{tag}</Tag>
        ))}
        {finding.rule && <Rule id={finding.rule} report />}
        {finding.reporter && finding.reporter !== "review" && (
          <Tag title="Who reported this">
            {finding.reporter === "pr-comment"
              ? `@${finding.reporterName ?? "someone"}`
              : (finding.reporterName ?? "you")}
          </Tag>
        )}
        <State>{finding.resolution}</State>
        <span className="anchor">
          {finding.anchor.file}:{finding.anchor.line}
          {span}
        </span>
      </p>

      <Notes finding={finding} />

      {/*
        The reader's own note above the argument: it is the newer of the two,
        and it is the one written by the person the argument was addressed to.
      */}
      {finding.note && (
        <div className="own-note">
          <p className="meta">
            Note{finding.noteAt ? ` · ${finding.noteAt.slice(0, 10)}` : ""}
          </p>
          <Markdown body={finding.note} />
        </div>
      )}

      {/* The argument first, then the evidence for it. A reader who starts in
          the code has to work out what they are being shown. */}
      <div className="body">
        <Markdown body={finding.body} />
      </div>

      <Chunks
        anchor={{
          file: finding.anchor.file,
          line: finding.anchor.line,
          endLine: finding.anchor.endLine,
          context: finding.context,
          diff: finding.diff,
        }}
        related={finding.related}
      />

      {/* Revealed by enhance.ts once it knows a server is answering. A button
          that cannot do anything is worse than no button. */}
      <div className="actions" hidden>
        <button data-axis="verdict" data-act="accepted" data-id={finding.id}>
          Accept
        </button>
        <button data-axis="verdict" data-act="invalid" data-id={finding.id}>
          Invalid
        </button>
        <button data-axis="verdict" data-act="tolerated" data-id={finding.id}>
          Tolerate
        </button>
        <button data-axis="resolution" data-act="resolved" data-id={finding.id}>
          Resolve
        </button>
      </div>
    </article>
  );
}

export function Report({ data }: { data: ReportData }) {
  const groups = GROUP_ORDER.map((key) => ({
    key,
    findings: data.findings.filter((finding) => groupOf(finding) === key),
  })).filter((group) => group.findings.length > 0);

  const counts = groups
    .map(
      (group) =>
        `${GROUP_TITLES[group.key].toLowerCase()}: ${group.findings.length}`,
    )
    .join(" · ");

  return (
    // A rule id in the prose has nowhere to go in a file opened from disk, so
    // it is drawn as a reference rather than as a link. The enhancement turns
    // them into links once it has found a server to point them at.
    <MarkdownSurface surface={{ rule: () => null }}>
      <header>
        <h1>{data.target}</h1>
        <p className="meta">{data.repo}</p>
        <p className="meta">{counts}</p>
        <p className="meta">generated {data.generatedAt}</p>
        <p className="meta" id="live">
          Read-only. Run the triage UI to rule on findings from here.
        </p>
      </header>
      {data.findings.length === 0 && (
        <p className="empty">No findings recorded for this target yet.</p>
      )}
      {groups.map((group) => (
        <section className="group" id={`group-${group.key}`} key={group.key}>
          <h2>
            {GROUP_TITLES[group.key]}{" "}
            <span className="count">{group.findings.length}</span>
          </h2>
          {group.findings.map((finding) => (
            <One finding={finding} key={finding.id} />
          ))}
        </section>
      ))}
    </MarkdownSurface>
  );
}

export interface RulePageData {
  id: string;
  title: string;
  doc: string;
  description: string | null;
  body: string | null;
}

/**
 * One rule, on its own page.
 *
 * The report is a file on disk with no panel to open anything in, so a rule
 * reference there opens a tab on the server instead. Same components and the
 * same stylesheet as the report, so arriving here does not feel like leaving.
 */
export function RulePage({ rule }: { rule: RulePageData }) {
  return (
    <MarkdownSurface surface={{ rule: (id) => ({ href: `/rule/${id}` }) }}>
      <header>
        <h1>
          <span className="id">{rule.id}</span> {rule.title}
        </h1>
        <p className="meta">{rule.doc}</p>
      </header>
      <div className="body">
        {rule.body === null ? (
          <p className="empty">
            The handbook file for this rule is not packaged here.
          </p>
        ) : (
          <Markdown body={rule.body} />
        )}
      </div>
    </MarkdownSurface>
  );
}
