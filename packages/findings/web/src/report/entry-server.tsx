/**
 * What Node calls to turn findings into a report.
 *
 * Static markup rather than a hydration-ready render: the report has to be
 * readable as a document first, and the script that takes over is optional by
 * design. React re-renders from the same data on the other side.
 */

import { renderToStaticMarkup } from "react-dom/server";
import {
  Report,
  RulePage,
  type ReportData,
  type RulePageData,
} from "./Report.tsx";

export function renderReport(data: ReportData): string {
  return renderToStaticMarkup(<Report data={data} />);
}

export function renderRulePage(rule: RulePageData): string {
  return renderToStaticMarkup(<RulePage rule={rule} />);
}

export type { ReportData, RulePageData };
