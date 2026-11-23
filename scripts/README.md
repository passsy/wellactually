# Build and release scripts

These scripts build, test and stage the current packages. Run npm commands from
the repository root. Publishing procedures live in
[the plugin package](../packages/connector/PUBLISHING.md) and
[the detector SDK package](../packages/detector-sdk/PUBLISHING.md).

| Script | Caller or maintainer use | Purpose |
| --- | --- | --- |
| `build.mjs` | `npm run build`; CI | Builds development runtime and review-skill launchers. |
| `build-runtime.mjs` | `build.mjs`, `package.mjs` | Shared runtime build for development and npm archives. |
| `package.mjs` | `npm run package`; CI; local installer | Builds the prebuilt plugin archive and candidate catalogs. |
| `test-package.mjs` | `npm run test:package`; CI | Installs and checks packed host entry points, MCP, UI assets and Git adapters. |
| `install-local.mjs` | `npm run package:local`, `npm run install:local`; CI | Builds a private local plugin package; `--host` also installs it. |
| `sync-skills.mjs` | `package.mjs`; generation tests | Creates the OpenCode/pi skill layout in the archive. |
| `release-sdk.mjs` | `npm run package:sdk`; CI | Builds and packs the detector SDK; it does not publish it. |
| `test-sdk-package.mjs` | `npm run test:package:sdk`; CI | Checks installed SDK declarations, bundled notices and v3/v4 detector tests. |
| `bundle-notices.mjs` | `release-sdk.mjs`; notice tests | Collects licenses and NOTICE files of bundled dependencies. |
| `publish-package.mjs` | `publish.yaml`, `publish-sdk.yaml` | Stages the tested plugin or SDK archive for human npm approval. |
| `stage-package.mjs` | `publish-package.mjs`; publication tests | Validates npm's staged-package receipt and expected artifact identity. |
| `verify-package.mjs` | `publish-package.mjs`; post-approval maintainer verification; tests | Verifies public npm metadata and tarball integrity. |
| `version.mjs` | Maintainer plugin promotion | Updates exact plugin versions and npm dependency pins after verification. |
| `embed-sdk.mjs` | Maintainer after detector SDK source changes | Refreshes embedded SDK source; a test detects stale output. |
| `freeze-api.mjs` | Maintainer introducing a new detector API version | Records the immutable event shape of a version; refuses to overwrite an existing version. |

Build output and generated skill layouts are ignored. The embedded SDK source
and frozen detector API compatibility fixtures are tracked and checked by tests.
Do not regenerate frozen fixtures to make an incompatible API change pass.
