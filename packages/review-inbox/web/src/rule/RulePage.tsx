/**
 * One rule, on its own page.
 *
 * Rendered by Node as static markup and served at `/rule/<id>`, so a rule
 * reference in the card, the inbox or an agent's message opens something
 * readable in a browser tab.
 */

import { Markdown, MarkdownSurface } from "../shared/markdown/Markdown.tsx";

export interface RulePageData {
  id: string;
  title: string;
  doc: string;
  description: string | null;
  body: string | null;
}

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
