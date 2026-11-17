# Git-install compatibility

`pi.mjs` is the pi extension entry point declared in the repository root's
`package.json`. It keeps existing Git-based pi installations working after the
runtime moved to npm. Removing it would break those installations.

The adapter re-exports `wellactually-runtime/pi`. `wellactually-runtime` is an
npm alias pinned to an exact published `wellactually` version in the root
manifest and lockfile. The package manager installs it; the adapter performs no
downloads or builds when the agent runs. It contains no separate implementation.

New pi installations use `pi install npm:wellactually` and load the npm package's
own extension entry point. They do not use this folder.

During a plugin promotion, `scripts/version.mjs` updates the dependency pin.
The [plugin publishing guide](../packages/cli/PUBLISHING.md) describes that flow.
`scripts/test-package.mjs` checks this adapter's contract along with the
OpenCode Git adapters in `opencode/`.
