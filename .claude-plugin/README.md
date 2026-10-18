# .claude-plugin

What Claude Code reads to install the plugin.

- `marketplace.json` makes this repository a marketplace, so `/plugin marketplace add passsy/wellactually` works.
- `plugin.json` names the plugin and starts its MCP server, the `wellactually` command in [dist](../dist).

Claude Code looks for this folder at the root of the repository, so it cannot move.
