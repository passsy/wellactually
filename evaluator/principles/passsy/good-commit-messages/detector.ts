import { mentioned, onCommand, onPrompt } from "@wellactually/sdk/v3";

// The rule arrives when the user asks for a commit, and in full right before
// `git commit -m` runs, while the message can still change.

// Not a language rule: a commit message reads the same in every repository.
// Singular only. "commit" is somebody about to write one; "commits" is almost
// always somebody reading history, which this rule has nothing to say about.
onPrompt({
  *detect(event) {
    yield* mentioned(event, ["commit"]);
  },
});

onCommand({
  *detect(event) {
    // `git commit -m` at the start of a command, not inside a quoted string.
    const match = /(?:^|[\n;&|()])\s*(git\s+commit\s+-m)(?:\s|=)/i.exec(event.command);
    if (match?.[1]) {
      yield { match: match[1] };
    }
  },
});
