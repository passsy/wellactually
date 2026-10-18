# scripts

How [dist](../dist) is built.

- `build.mjs` bundles the command into `dist/wellactually.mjs`, run by `npm run build`.
- `embed-sdk.mjs` writes the SDK's source into the core as strings, because a detector is built where no filesystem holds the SDK.
- `freeze-api.mjs` freezes a detector API version, so that later releases can prove they still run detectors written against it.
