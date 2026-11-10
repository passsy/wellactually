# Build and release scripts

- `build-runtime.mjs` builds the shared runtime layout for development and npm.
- `build.mjs` writes ignored local runtime/skill-launcher outputs.
- `package.mjs` builds a dependency-free npm archive under ignored `.artifacts/`.
- `test-package.mjs` installs that archive outside the checkout with scripts
  disabled and checks host entrypoints, MCP, UI assets and Git adapter contracts.
- `sync-skills.mjs` generates the namespaced OpenCode/pi skills inside the archive.
- `publish-package.mjs` publishes the tested archive from the explicit release job.
- `version.mjs` promotes a published version in manifests and compatibility pins.
  Refresh package-lock.json afterwards. Never point installers at an unpublished version.
- `release-sdk.mjs` publishes the separate SDK Git branch.
- `embed-sdk.mjs` embeds SDK source for detector builds; `freeze-api.mjs` freezes
  detector API versions.

Generated bundles and mirrored skills are never committed to Git.
