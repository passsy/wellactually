/**
 * The dev server for the triage page.
 *
 * Only the inbox runs here. The report is a build artifact rather than a page
 * anybody browses to, so it has no dev mode of its own: see build.mjs.
 *
 * Everything the page asks for that is not a page comes from the findings
 * server, which is a different process on a fixed port. So the API, the
 * generated report, the icons and the service worker are proxied rather than
 * faked, and the dev page talks to the same routes the built one does.
 */

import { defineConfig } from "vite";
import { UI_PORT } from "../serve/port.mts";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

/** Where the findings server is listening while you develop against it. */
const SERVER = `http://127.0.0.1:${UI_PORT}`;

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwind()],
  resolve: {
    alias: { "@": `${import.meta.dirname}/src` },
  },
  server: {
    port: 5199,
    strictPort: true,
    proxy: {
      "/api": { target: SERVER, changeOrigin: true },
      "/review.html": { target: SERVER, changeOrigin: true },
      "/rule": { target: SERVER, changeOrigin: true },
      "/sw.js": { target: SERVER, changeOrigin: true },
      "/manifest.webmanifest": { target: SERVER, changeOrigin: true },
      "^/icon-\\d+\\.png$": { target: SERVER, changeOrigin: true },
    },
  },
});
