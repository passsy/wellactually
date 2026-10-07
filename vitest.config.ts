import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A principle's *.test.ts files are run by `wellactually test`, inside the isolate, not by vitest.
    exclude: [...configDefaults.exclude, "principles/**"],
  },
});
