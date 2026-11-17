# Detector SDK releases

`@wellactually/detector-sdk` is the author-facing package for detector APIs and
local detector tests. It is released separately from the `wellactually` plugin.
The npm package version is independent of the API paths: both `/v3` and `/v4`,
and their `/test` exports, are included. Publish SDK changes when its public API,
types, builder or test runtime changes, not for every plugin or UI release.

## Author installation and migration

After the first npm release is approved:

```sh
npm install --save-dev @wellactually/detector-sdk vitest
```

```ts
import { onWrite } from "@wellactually/detector-sdk/v4";
// In detector.test.ts:
import { detect, write } from "@wellactually/detector-sdk/v4/test";
```

The SDK requires Node >=22.18.0. It contains compiled JavaScript, public type
declarations and the real detector builder/test runtime. esbuild is its only
runtime npm dependency. The raw `packages/sdk` workspace is private and imports
internal workspaces; never publish it directly.

To migrate an existing author project, install the new package, change imports
from `@wellactually/sdk/vN` to `@wellactually/detector-sdk/vN` (including `/test`),
and remove the old SDK dependency after its tests pass. Keep the same API version;
the package rename is not an API migration. The compatibility resolver accepts
both names, including mixed names using the same API version. It still rejects
mixed API versions. Existing frozen detector bundles are unchanged. The historical
Git `sdk` branch remains available for old installs; no new release is written there.

## Before the first public SDK release

1. Ensure the npm account/organization controls the `@wellactually` scope and
   the `@wellactually/detector-sdk` package name. The existing unscoped
   `wellactually` package does not establish ownership of that scope.
2. Merge and deploy the dual-name import resolver to the registry/browser builder
   and checker, and release/promote the corresponding plugin support. Old hosts
   only understand the old SDK name. Do not advertise new-name author imports
   until these consumers can build them. Package tests do not prove production
   registry deployment.
3. Bootstrap the package's npm settings if it does not exist yet. npm supports a
   first staged upload creating a placeholder package; a maintainer can stage the
   tested tarball interactively with `npm stage publish <tarball> --access public
   --tag latest --ignore-scripts`, inspect it, then configure the package settings.
   No SDK upload or npm account setup is performed merely by merging this change.
4. Configure its **own** trusted publisher: GitHub Actions, repository
   `passsy/wellactually`, workflow filename `publish-sdk.yaml`, no environment
   restriction. Enable staging only; leave direct publishing disabled. The
   plugin's existing publisher for `publish.yaml` does not cover this package.

Keep a manually bootstrapped stage until it is reviewed; do not upload the same
reserved version again. GitHub provenance applies to artifacts staged by Actions.
Both CLI staging and Actions staging still need human 2FA approval to publish.

## Local packaging and testing

From the repository root:

```sh
npm ci --ignore-scripts
npm run typecheck
npm run package:sdk -- --version 0.1.0
npm run test:package:sdk
```

The version is an example; choose a new exact version for a release. If omitted,
local packaging uses `packages/sdk/package.json`, not the plugin version.
Output is ignored `.artifacts/detector-sdk/`: compiled `package/`, npm tarball,
and npm's `pack.json` with its SHA-512 integrity. No Git branch or manifest is
rewritten. Declaration generation must succeed; missing transitive public types
are caught by a clean consumer's type-check with library checking enabled.

The packed test installs outside the checkout with lifecycle scripts disabled,
using the actual tarball and normal npm dependencies. It checks v3/v4 imports,
public declarations, and runs the example detector tests through the packaged
builder and isolate. Dependency downloads may be needed. This does not install
or update Claude/Codex plugins or require an npm publishing credential.
PR CI also builds and tests this SDK archive.

The archive includes `THIRD_PARTY_NOTICES.txt` alongside the SDK's own Apache
`LICENSE`. Packaging uses esbuild's output metadata to collect the full installed
license/copyright files and any top-level NOTICE from each npm dependency that
contributes bundled code. This includes the embedded QuickJS engine's upstream
notices. Dependencies installed separately, such as esbuild, retain their notices
in their own packages. Legal comments in bundled source are also preserved.
A bundled package without a nonempty license file stops packaging for review.
The packed-consumer check verifies complete QuickJS licenses in the installed
archive, so a file omitted from npm's allowlist fails CI. Recheck any newly bundled
dependency for additional obligations; collecting notices is not a license audit.

## Stage and approve a release

1. Merge the intended SDK changes to `main`, and choose a new SDK version.
   There is no need to bump the plugin or marketplace pins.
2. Open Actions → **Release detector SDK** (`publish-sdk.yaml`), select `main`,
   enter the exact SDK `version`, and enable `stage`. Leave it off for a build-only
   rehearsal. The workflow tests source, then the packed consumer on LTS,
   Node 22.18.0 (the floor), Node 24, and latest stable Node.
3. A separate OIDC job downloads the tested archive and checks its name, version
   and integrity before staging it under `latest`, with provenance and without
   installing dependencies or running the archive. The workflow ends at staging.
   The summary and `wellactually-detector-sdk-stage` artifact contain the stage ID.
4. Inspect that staged package and compare it with the Actions
   `wellactually-detector-sdk-release` artifact. Approve it in npm's Staged
   Packages with 2FA. Approval publishes the version and moves only its `latest`.
   There is no `next`, recurring checker, or automatic approval.
5. Download the original release artifact into a fresh directory and verify
   public metadata and tarball bytes against its `pack.json`, using
   `verifyPublishedPackage` from `scripts/verify-package.mjs` as in the
   [plugin release guide](releasing-review.md#4-verify-publication-and-optionally-invite-testers).
   Substitute artifact name `wellactually-detector-sdk-release`. Do not rebuild
   to manufacture a new expected integrity. Only announce after this succeeds.
6. Users install an exact candidate with
   `npm install --save-dev @wellactually/detector-sdk@<version>`; their lockfile
   pins the resolved package. The SDK has no plugin marketplace promotion step.

A failed candidate is immutable: fix the source and choose another version.
Rerunning the Actions workflow for a public version verifies identical bytes
rather than republishing. The plugin's exact pins and release process remain
independent. Local source state can advance beyond a published SDK; record the
Actions run, source commit, version and integrity for every release.

See [npm staged publishing](https://docs.npmjs.com/staged-publishing/) and
[trusted publishing](https://docs.npmjs.com/trusted-publishers/).
