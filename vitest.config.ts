import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // The web app imports its own files as "@/...", like its tsconfig says.
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "apps/web/src") } },
  test: {
    // A detector gets 100 ms of wall clock, and every test file builds its principle in a child process.
    // With a worker on every core the machine is so busy that a detector runs out of time before it starts.
    maxWorkers: "50%",
    // A principle's tests do not import its detector: `detect()` builds it. So a
    // change to one has to be named as a reason to run the tests again while watching.
    forceRerunTriggers: [...configDefaults.forceRerunTriggers, "**/detector.ts", "**/principle.md", "**/fixtures/**"],
  },
});
