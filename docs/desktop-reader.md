# Read-only reviews in Claude Desktop

Claude Code can run a review while Claude Chat displays its live results. Some
Claude Desktop versions omit the tool-call bridge for Code plugin cards; a later
snapshot can show newer results, but delaying it does not restore live updates.
The Desktop MCP connector uses the working Chat route.

Build and install locally:

```sh
npm run build
node scripts/install-desktop-reader.mjs
```

Restart Claude Desktop. In **Claude Chat**, ask: “Use wellactually-reader to list
my reviews, then show the live card for [project and PR].” Keep running the review
in the coding session. Existing Code cards remain snapshots on affected hosts.

The `desktop-mcp` command exposes only `list_reviews`, `review_status`, and
`list_occurrences`. It reads registered reviews, saved occurrences and captured
code. It does not start the browser inbox server, execute review workers, or
expose authoring, voting, notes, posting, or arbitrary file-reading tools. Cards
are marked read-only and omit mutation controls. This is an application-level
read-only interface, not an OS filesystem sandbox.

The installer preserves other Desktop settings and connectors, backs up the
configuration, and copies built assets to `~/.well-actually/desktop-reader`, so
the connector does not depend on an ephemeral plugin cache. Rerun it after UI
updates. To uninstall, remove `wellactually-reader` from `mcpServers` in Claude's
Desktop configuration, restart Claude, then remove that folder.

For manual installation, configure a stdio MCP server whose command is the full
path to Node and whose arguments are the full path to `dist/wellactually.mjs`
and `desktop-mcp`. Set `WELLACTUALLY_REVIEW_HOST=claude` for Claude's inbox links.
