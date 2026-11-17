# Claude findings delivery

Inline findings cards are temporarily disabled in Claude because the Desktop Code
tab cannot reliably forward their refresh and voting calls. This applies to
startup, progress, final and replacement cards.

Use the browser inbox link returned by `start_review` for live findings, votes and
notes. `review_status` remains available as a text summary. The normal plugin MCP
server and inbox keep the coding session's lifecycle. Codex retains its interactive
inline card.

The experimental `desktop-mcp` reader and its installer remain in source for
diagnostics. They are not part of the recommended installation, and reviews must
not install a separate Desktop connector as a workaround.
