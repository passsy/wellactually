import { mentioned, onPrompt, onWrite } from "@wellactually/sdk/v3";

onPrompt({
  *detect(event) {
    yield* mentioned(event, ["markdown", "markdownlint"]);
  },
});

/**
 * The file name is the whole signal: any .md the agent writes deserves the
 * style rules, and the rule text does the linting once injected. Reading a
 * markdown file is not writing one. The finding points at the file.
 */
onWrite({
  globs: ["**/*.md"],
  *detect(event) {
    yield {};
  },
});
