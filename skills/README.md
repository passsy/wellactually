# skills

The things you do yourself, as skills of the plugin.

- `login` connects this machine to your advisory board on [wellactually.dev](https://wellactually.dev) and downloads it.
- `sync` downloads it again after you changed it on the website.
- `disable` stops all advice in the project you work in, on this machine, and `enable` brings it back.
  With a principle's id they switch only that principle.
- `audit` looks back at your recent sessions and says, for each, whether the hooks ran, which principles fired, what advice reached the agent and whether it rated it.
  Where something did not happen, it says why.
- `review` reviews a change, a branch or a pull request against every principle on your advisory board.
  The detectors run on the changed lines, every principle gets a verdict, and each finding names the principle it breaks.

Claude Code offers them as `/wellactually:login`, `/wellactually:sync`, `/wellactually:disable`, `/wellactually:enable`, `/wellactually:audit` and `/wellactually:review`, Codex as `$wellactually:login` and so on.
