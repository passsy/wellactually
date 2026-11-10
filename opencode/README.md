# OpenCode

Install the prebuilt package from npm:

```bash
opencode plugin add wellactually
```

This directory preserves existing Git installs using `#path:opencode`. Its small
server/TUI adapters depend on `wellactually-runtime`, an alias of the exact npm
release pinned in package.json. It contains no runtime bundles or mirrored skills.
The installed npm package provides both the command and namespaced skills.

For a manual OpenCode 1 clone, run `npm install --ignore-scripts` here after pulling
updates so the pinned prebuilt dependency is available.
