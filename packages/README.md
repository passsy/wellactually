# packages

The source of everything that runs on your machine.

- `cli` is the `wellactually` command: the hooks the plugin calls, the MCP server and the commands for authoring principles.
- `core` builds, checks and runs principles: the sandbox a detector runs in, the test runner and the local advisory board.
- `sdk` is what a detector imports, and what its tests import to run under vitest.

[dist](../dist) is built from here.
