/**
 * One rule, on its own page.
 *
 * The card, the inbox and agents link here, so a rule reference opens
 * something readable in a browser tab.
 */

import { renderRulePage, ruleStyle } from "./web-assets.mts";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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
<style>${ruleStyle()}</style>
</head>
<body>
${renderRulePage(rule)}
</body>
</html>
`;
}
