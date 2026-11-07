/**
 * The view that always works.
 *
 * A single file with everything inlined, so a review survives being copied to
 * a machine that has none of this installed, or mailed to someone who never
 * will. When the triage server happens to be running on the same machine the
 * page notices and grows buttons; when it is not, it is still the report.
 *
 * Nobody reads a review here by choice — that is the inbox, and this is the
 * safety net under it. Worth knowing before spending anything on this file:
 * it has to stay legible and stay small, and it does not have to keep up.
 * The inbox draws the system map with mermaid and this prints the fence,
 * which is the shape of that trade rather than a hole to be filled.
 */

import { type Finding } from "../model/types.mts";
import { UI_PORT } from "../serve/port.mts";
import {
  renderReport,
  renderRulePage,
  reportScript,
  reportStyle,
} from "../serve/web-assets.mts";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface ViewContext {
  repo: string;
  target: string;
  generatedAt: string;
}

export function toHtml(context: ViewContext, findings: Finding[]): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review ${escapeHtml(context.target)}</title>
<style>${reportStyle()}</style>
</head>
<body>
${renderReport({ ...context, findings })}
<script type="application/json" id="report-data">${json({
    repo: context.repo,
    target: context.target,
    port: UI_PORT,
  })}</script>
<script>${reportScript()}</script>
</body>
</html>
`;
}

/**
 * One rule, on its own page.
 *
 * Served to the generated report, which has no panel to open a rule in, so a
 * reference there opens a tab here instead.
 */
export function rulePage(rule: {
  id: string;
  title: string;
  doc: string;
  description: string | null;
  body: string | null;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(rule.id)} ${escapeHtml(rule.title)}</title>
<style>${reportStyle()}</style>
</head>
<body>
${renderRulePage(rule)}
</body>
</html>
`;
}

/** `</script>` inside data would end the block early. */
function json(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
