import { mentioned, onCommand, onPrompt } from "@wellactually/sdk/v3";

// Only speaks when the conventional format actually shows up: as a topic in a
// prompt, or in the subject about to be committed.
onPrompt({
  *detect(event) {
    yield* mentioned(event, ["conventional commit", "conventional commits"]);
  },
});

onCommand({
  *detect(event) {
    const subject = commitSubject(event.command);
    // A subject that leads with feat:, fix(scope):, chore!: and friends.
    if (subject !== null && /^(?:feat|fix|chore|docs|refactor|test|style|perf|ci|build|revert)(?:\([^)]*\))?!?:/.test(subject)) {
      yield { match: subject };
    }
  },
});

/** The first line of the -m argument, or null when this is no commit. */
function commitSubject(command: string): string | null {
  const flag = /git\s+commit\b[^\n;|&]*?(?:-m|--message)(?:\s+|=)(["'])/.exec(command);
  if (!flag) {
    return null;
  }

  const quote = flag[1] as string;
  const after = command.slice(flag.index + flag[0].length);
  const end = after.indexOf(quote);
  let message = after;
  if (end !== -1) {
    message = after.slice(0, end);
  }

  const lines = message.split("\n");
  const first = (lines[0] ?? "").trim();
  // The heredoc idiom puts the subject on the line after the marker.
  if (/^\$\(\s*cat\s*<<-?\s*['"]?\w+['"]?\s*$/.test(first)) {
    return (lines[1] ?? "").trim();
  }
  return first;
}
