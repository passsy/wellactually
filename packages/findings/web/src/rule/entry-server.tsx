/** What Node calls to render a rule page. */

import { renderToStaticMarkup } from "react-dom/server";
import { RulePage, type RulePageData } from "./RulePage.tsx";

export function renderRulePage(rule: RulePageData): string {
  return renderToStaticMarkup(<RulePage rule={rule} />);
}

export type { RulePageData };
