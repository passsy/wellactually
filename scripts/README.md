# scripts

How [dist](../dist), [opencode](../opencode) and the `sdk` branch are made.

- `build.mjs` bundles the main command and the skill-local review helper, then copies the package and skills into `opencode`, run by `npm run build`.
- `sync-skills.mjs` recreates the generated skill copies in `opencode/skills`, called by the build.
- `version.mjs` sets the version of a release in the command, every agent's manifest and the OpenCode package.
- `release-sdk.mjs` writes the SDK built, with its `package.json` at the root, into a checkout of the `sdk` branch.
- `embed-sdk.mjs` writes the SDK's source into the core as strings, because a detector is built where no filesystem holds the SDK.
- `freeze-api.mjs` freezes a detector API version, so that later releases can prove they still run detectors written against it.
