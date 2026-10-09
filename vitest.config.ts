import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A principle's tests do not import its detector: `detect()` builds it. So a
    // change to one has to be named as a reason to run the tests again while watching.
    forceRerunTriggers: [...configDefaults.forceRerunTriggers, "**/detector.ts", "**/principle.md", "**/fixtures/**"],
  },
});
