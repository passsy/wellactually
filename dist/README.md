# dist

The built command, the files the installed plugin runs.

- `wellactually.mjs` is the `wellactually` command: the hooks, the MCP server and the authoring commands.
- `wellactually-worker.mjs` runs detectors in worker threads, and `wellactually-log.mjs` writes the hook log.
- `pi.mjs` is the extension pi loads.

An agent copies a plugin from git without running `npm install` or a build, so these files are committed.
They are built from [packages](../packages) with `npm run build`, with every dependency bundled.
