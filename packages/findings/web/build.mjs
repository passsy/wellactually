/**
 * Builds the artifacts the findings server serves.
 *
 * The server has no bundler of its own and no network at runtime, so
 * everything a browser will ever need has to exist as bytes on disk before
 * the server starts. That is what this produces:
 *
 *   inbox.html      the triage page, one self-contained file. No external
 *                   request, which is what lets the same bundle be handed to
 *                   a widget host later, and what makes it work offline now.
 *   card.html       the review card a host draws in the conversation: an MCP
 *                   App, which is the widget host the line above was waiting
 *                   for. One file, because its sandbox allows nothing else.
 *   report.js/css   the interactive half of a generated review.html, as one
 *                   IIFE with nothing to import, so it can be inlined into a
 *                   file somebody opens from their downloads folder.
 *   report-ssr.mjs  the same components rendered by Node at write time, so
 *                   the report is readable as markup before any script runs.
 *
 * Run by `npm run web:build`, and by the release build before esbuild.
 */

import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const WEB = import.meta.dirname;
const OUT = join(WEB, "dist");

/** The same alias the dev config carries, for every bundle built here. */
const ALIAS = { resolve: { alias: { "@": join(WEB, "src") } } };

await rm(OUT, { recursive: true, force: true });

const plugins = () => [react(), tailwind()];

/** The triage page: one file, nothing fetched, nothing left beside it. */
await build({
  ...ALIAS,
  root: WEB,
  logLevel: "warn",
  plugins: [...plugins(), viteSingleFile()],
  build: {
    outDir: join(OUT, "inbox"),
    emptyOutDir: true,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    rollupOptions: { input: join(WEB, "index.html") },
  },
});

/**
 * The review card. Built the way the triage page is, and for a stricter
 * reason: a host renders it in a sandbox that denies every outside origin, so
 * what is not inside this one file does not exist.
 */
await build({
  ...ALIAS,
  root: WEB,
  logLevel: "warn",
  plugins: [...plugins(), viteSingleFile()],
  build: {
    outDir: join(OUT, "card"),
    emptyOutDir: true,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    rollupOptions: { input: join(WEB, "card.html") },
  },
});

/**
 * The report's client half, and its stylesheet.
 *
 * An IIFE rather than a module: this ends up between script tags inside a
 * file that is opened from disk, where a module's import would be a request
 * to a directory that is not there.
 *
 * No React in here on purpose. Hydrating the report would mean inlining half
 * a megabyte into a file that is six kilobytes today and whose whole point is
 * that you can send it to somebody. The components still render it — Node
 * does that at write time — and this only adds what needs a live server.
 */
await build({
  ...ALIAS,
  root: WEB,
  logLevel: "warn",
  plugins: plugins(),
  build: {
    outDir: join(OUT, "report"),
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    lib: {
      entry: join(WEB, "src", "report", "enhance.ts"),
      formats: ["iife"],
      name: "PascalReport",
      fileName: () => "report.js",
      cssFileName: "report",
    },
  },
});

/**
 * The same components, for Node to render with at write time.
 *
 * Bundled rather than left to import React at runtime: the release artifact
 * ships no node_modules, so anything this file still expects to resolve is a
 * crash on somebody else's machine.
 */
await build({
  ...ALIAS,
  root: WEB,
  logLevel: "warn",
  plugins: plugins(),
  ssr: { noExternal: true },
  build: {
    outDir: join(OUT, "ssr"),
    emptyOutDir: true,
    ssr: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: join(WEB, "src", "report", "entry-server.tsx"),
      // CommonJS, so the server can load it with createRequire and keep
      // writing a report synchronously. Every caller of toHtml is on the
      // write path of a tool call, and making that async to satisfy a
      // dynamic import would turn one bundling decision into a change of
      // shape across the whole store.
      output: { entryFileNames: "report-ssr.cjs", format: "cjs" },
    },
  },
});

/**
 * The page an installed window shows when nothing is serving.
 *
 * Its own bundle rather than a corner of the report's, because it is inlined
 * into the service worker: a browser fetches that before it will install
 * anything, and the report's stylesheet is fifteen kilobytes of reset and
 * utilities for components this page does not have.
 */
await build({
  ...ALIAS,
  root: WEB,
  logLevel: "warn",
  plugins: plugins(),
  build: {
    outDir: join(OUT, "offline"),
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    lib: {
      entry: join(WEB, "src", "offline", "enhance.ts"),
      formats: ["iife"],
      name: "PascalOffline",
      fileName: () => "offline.js",
      cssFileName: "offline",
    },
  },
});

await build({
  ...ALIAS,
  root: WEB,
  logLevel: "warn",
  plugins: plugins(),
  ssr: { noExternal: true },
  build: {
    outDir: join(OUT, "offline-ssr"),
    emptyOutDir: true,
    ssr: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: join(WEB, "src", "offline", "offline-server.tsx"),
      output: { entryFileNames: "offline-ssr.cjs", format: "cjs" },
    },
  },
});

process.stdout.write(
  "web: inbox.html, card.html, report.js, report-ssr.cjs, offline.js, offline-ssr.cjs\n",
);
