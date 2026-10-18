# .codex-plugin

What Codex reads to install the plugin.

- `plugin.json` names the plugin and points at its skills and its MCP server.
- `mcp.json` starts the MCP server, the `wellactually` command in [dist](../dist).

Codex has a manifest of its own because it resolves the server's path differently from Claude Code.
It reads the hooks from [hooks](../hooks), like Claude Code.
