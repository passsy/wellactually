/**
 * Lint for the two web clients.
 *
 * Its own config rather than a section of the plugin's, because this is the
 * only code in the repository that runs in a browser: it has the DOM, it has
 * hooks with rules a type checker cannot see, and it does not have Node.
 */

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

/**
 * Every pattern here is written to match from the repository root as well as
 * from this directory, because the script that runs it lives in the root
 * package and flat config resolves globs against the working directory.
 */
/**
 * Vendored shadcn components export their cva variants beside the component,
 * which is the shape the whole ecosystem copies them in. The fast-refresh
 * warning is about editing ergonomics, and these files are not edited — they
 * are replaced from the registry.
 */
const vendored = {
  files: ["**/web/src/components/ui/**"],
  rules: { "react-refresh/only-export-components": "off" },
};

export default tseslint.config(
  { ignores: ["**/dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  // The flat build of it. The one at the top level still declares its plugins
  // as an array, which is the old config format and not what this file is.
  reactHooks.configs.flat["recommended-latest"],
  {
    files: ["**/web/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "react-refresh": reactRefresh },
    rules: {
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  {
    // The build script and the two tool configs are Node, and are checked by
    // tsconfig.node.json instead of by the app's project.
    files: ["**/web/*.mjs", "**/web/*.config.ts"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: globals.node },
  },
  vendored,
);
