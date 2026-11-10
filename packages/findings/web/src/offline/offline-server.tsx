/**
 * What the server calls to draw the page nobody wants to see.
 *
 * Static markup, and the only one of the three bundles that renders a whole
 * document: the offline page is not served, it is inlined into a service
 * worker, so nothing else is going to supply a head for it.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { Offline, type OfflineData } from "./Offline.tsx";

export function renderOffline(
  data: OfflineData,
  style: string,
  script: string,
): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Review Inbox — not running</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${style}</style></head>
<body>${renderToStaticMarkup(<Offline data={data} />)}
<script>${script}</script>
</body></html>`;
}

export type { OfflineData };
