# skills

The things you do yourself, as skills of the plugin.

- `login` connects this machine to your advisory board on [wellactually.dev](https://wellactually.dev) and downloads it.
- `sync` downloads it again after you changed it on the website.
- `disable` stops all advice in the project you work in, on this machine, and `enable` brings it back.
  With a principle's id they switch only that principle.
- `audit` looks back at your recent sessions and says, for each, whether the hooks ran, which principles fired, what advice reached the agent and whether it rated it.
  Where something did not happen, it says why.

Claude Code offers them as `/wellactually:login`, `/wellactually:sync`, `/wellactually:disable`, `/wellactually:enable` and `/wellactually:audit`, Codex as `$wellactually:login` and so on.
