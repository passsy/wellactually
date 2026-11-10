/**
 * The built web artifacts, found from wherever this code ended up.
 *
 * There are two answers and they are both normal. In the source tree this
 * file sits next to its own `dist/`, which is what `npm run ui` and the tests
 * see. In a release, esbuild has folded the server into one `.mjs` and the
 * build has copied the web output beside it, so the same lookup has to work
 * one directory shallower.
 *
 * Nothing is cached across a miss: a source checkout that has not run the web
 * build yet should say so every time it is asked, rather than once.
 *
 * A hit is kept, though. Installers delete the directory a running server was
 * started from — `codex plugin add` removes the old version's cache wholesale
 * — and a server that lazily re-reads its own assets then fails its first
 * page after every upgrade. The code survives that deletion because
 * Node holds it in memory; the assets survive it by being held the same way.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

/** Where the web build's output could be, nearest first. */
const ROOTS = [
  // The source tree: this file sits in runtime/findings/serve, the build
  // output beside it in runtime/findings/web/dist.
  new URL("../web/dist/", import.meta.url),
  // A release: the whole server is one bundled dist/findings-server.mjs with
  // dist/web copied in beside it, so the assets sit next to the bundle
  // wherever this module's source happened to live.
  new URL("./web/", import.meta.url),
];

export class MissingWebBuild extends Error {
  constructor(what: string) {
    super(
      `the web build is missing ${what}. Run "npm run web:build" — the triage page and the rule page are compiled, not written by hand.`,
    );
    this.name = "MissingWebBuild";
  }
}

function find(relative: string): string {
  for (const root of ROOTS) {
    const path = fileURLToPath(new URL(relative, root));
    if (existsSync(path)) return path;
  }
  throw new MissingWebBuild(relative);
}

const held = new Map<string, string>();

export function readAsset(relative: string): string {
  const kept = held.get(relative);
  if (kept !== undefined) return kept;
  const content = readFileSync(find(relative), "utf8");
  held.set(relative, content);
  return content;
}

/** The triage page: one file with everything already inside it. */
export function inboxHtml(): string {
  return readAsset("inbox/index.html");
}

/**
 * The review card: the MCP App a host renders in the conversation.
 *
 * One file for the same reason the triage page is, and here it is not a
 * choice. A host serves this from a sandbox with every outside origin denied,
 * so a script or a stylesheet beside it would be a request that never leaves.
 */
export function cardHtml(): string {
  return readAsset("card/card.html");
}

/** The rule page's stylesheet, to inline. */
export function ruleStyle(): string {
  return readAsset("rule/rule.css");
}

/**
 * The rule page renderer, loaded once and kept.
 *
 * `require` rather than `import`, so the HTTP route can stay synchronous. The
 * bundle is built as CommonJS for exactly this.
 */
let ruleRenderer: ((rule: unknown) => string) | null = null;

/** One rule, as a page, for links from the card, the inbox and agents. */
export function renderRulePage(rule: unknown): string {
  ruleRenderer ??= (
    createRequire(import.meta.url)(find("rule-ssr/rule-ssr.cjs")) as {
      renderRulePage: (rule: unknown) => string;
    }
  ).renderRulePage;
  return ruleRenderer(rule);
}

export function offlineStyle(): string {
  return readAsset("offline/offline.css");
}

export function offlineScript(): string {
  return readAsset("offline/offline.js");
}

let offline: ((data: unknown, style: string, script: string) => string) | null =
  null;

/** The page an installed window shows when nothing is serving. */
export function renderOffline(data: unknown): string {
  offline ??= (
    createRequire(import.meta.url)(find("offline-ssr/offline-ssr.cjs")) as {
      renderOffline: (data: unknown, style: string, script: string) => string;
    }
  ).renderOffline;
  return offline(data, offlineStyle(), offlineScript());
}
