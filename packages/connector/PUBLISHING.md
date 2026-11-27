# npm distribution and releases

All four hosts install one prebuilt `wellactually` npm package. Git contains
source, native manifests and small compatibility adapters; it contains no
committed `dist/` trees or mirrored OpenCode/pi skills.

## Install paths

Claude Code and Codex retain the `wellactually@wellactually` identity. Both
use `.claude-plugin/marketplace.json`, which pins an exact published npm
version. Keep this as the only marketplace catalog: an
`.agents/plugins/marketplace.json` would take precedence in Codex and could
bypass the published package. `scripts/version.mjs` updates the shared catalog
during promotion. Hosts fetch ready-to-run files without lifecycle scripts;
the Git source tree has no runnable bundles.

New OpenCode installs use `opencode plugin add wellactually`; pi uses
`pi install npm:wellactually`. Existing Git sources keep working: `opencode/`
exports and `compat/pi.mjs` import the `wellactually-runtime` npm alias. The Git
root pi manifest finds its namespaced skills in that dependency. Both aliases
pin the same published version as the catalog. They perform no downloads or
builds while the agent runs.

## Build and validate

Development tooling needs Node >=22.18. Installed packages support Node >=20.
Use the latest maintained LTS for development and installation. Node 20 is EOL;
its compatibility floor remains unchanged for existing users. The host application
may require a newer Node version than the plugin.

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run web:test --workspace @wellactually/review-inbox
npm run web:typecheck --workspace @wellactually/review-inbox
npm run package -- --version <new-version>
npm run test:package
```

Development runtime output goes to ignored `dist/`; the npm archive and candidate
catalog go to ignored `.artifacts/`. Packaging reads authored skills and generates
both host layouts with tiny launchers for a single compiled review helper.

Packed-product tests install outside the checkout, offline with scripts disabled,
and exercise four host entrypoints, MCP CRUD, card/inbox assets, version identity,
PNG icons and compatibility adapter contracts. CI builds and stages on the
latest LTS (`lts/*`), then tests the same archive on Node 20.0.0, the latest
Node 22 and 24 releases, and the latest stable release (`node`). The exact minimum
check deliberately stays on 20.0.0; replacing it with latest would stop validating
the declared `engines.node` floor. Esbuild targets Node 20 syntax; runtime tests
are still necessary because compilation cannot polyfill newer Node APIs.
These checks cover selected releases, not every intermediate patch or future major.
They do not establish actual desktop rendering or a complete review in every host.
Preserve those limits when describing a release.

## Local testing without publishing

For maintainers testing uncommitted or branch changes before any npm release,
run these commands from the repository root after `npm ci --ignore-scripts`.
The selected host CLI must be available on your PATH. No npm account or release
approval is needed.

Build a private tarball and local marketplace without changing any host settings:

```sh
npm run package:local
```

Or build and install it in one host (use `--host all` for both):

```sh
npm run install:local -- --host codex
# Or choose Claude or both hosts:
# npm run install:local -- --host claude
# npm run install:local -- --host all
```

The command builds from the current working tree using the release packager,
with a unique `*.local.<timestamp>` version and `private: true` so it cannot be
published accidentally. It installs the tarball offline with lifecycle scripts
disabled. Release outputs stay in `.artifacts/`; local outputs use
`.artifacts/local/`, and immutable local package copies live beneath
`~/.wellactually/local-marketplace/versions/`.

`--destination <directory>` changes that local marketplace location. Preparing
alone does not register or enable a plugin. Passing `--host` switches only that
host's `wellactually@wellactually` catalog to the local package, preserving its
identity and review stores. It does not edit the public catalog or hook trust.
Restart the host/start a fresh session after installation; Codex may ask for one
review of the changed hooks. Older local version directories are retained while
existing host sessions may still use them.

Rerun the command after changing the source; each run builds a new immutable
local version. Other maintainers run it in their own checkout. To leave local
testing, follow [Return to the public marketplace](#return-to-the-public-marketplace).

## Test a published npm version before marketplace promotion

Use this when testers need the actual npm package without building the source.
The maintainer first completes release steps 1–4 below, including npm 2FA approval
and artifact verification, but does not promote the public marketplace pins.
Share the exact published version and these instructions with testers.

Here, “before release to plugin users” means before `latest` moves to it.
The npm version is already public under `next`; anyone asking for that exact
version or tag receives it, and frozen plugins following the preview channel
install it. Everyone else stays on `latest`. A staged but unapproved package
cannot be installed this way.

A tester needs Node/npm and the chosen host CLI, but no repository checkout or
npm publishing credentials. Create a local marketplace with an exact npm source.
Replace `0.11.0-rc.4` with the version the maintainer supplied; the number here is
an example, not a promise that this version exists:

```sh
node --input-type=module - 0.11.0-rc.4 <<'JS'
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const version = process.argv[2];
const directory = path.join(os.homedir(), ".wellactually", "npm-test-marketplace", ".claude-plugin");
const catalog = {
  name: "wellactually",
  owner: { name: "Pascal Welsch" },
  metadata: { description: "Test one exact Well Actually npm version", version },
  plugins: [{
    name: "wellactually",
    version,
    source: { source: "npm", package: "wellactually", version },
  }],
};
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, "marketplace.json"), JSON.stringify(catalog, null, 2) + "\n");
JS
```

This writes only a local catalog. It uses the existing `wellactually@wellactually`
identity so the test package replaces the normal plugin instead of running two
copies of its hooks. Both the entry and its npm source pin the requested version.
It does not edit the public marketplace, publish anything, or build from source.

For **Codex**, remove the existing marketplace registration if present, then
register the test catalog and install it:

```sh
codex plugin marketplace list --json
# If wellactually is already registered:
codex plugin marketplace remove wellactually
codex plugin marketplace add "$HOME/.wellactually/npm-test-marketplace"
codex plugin add wellactually@wellactually --json
```

For **Claude**, register the test catalog and update an existing user-scoped
installation:

```sh
claude plugin marketplace add "$HOME/.wellactually/npm-test-marketplace"
claude plugin update wellactually@wellactually --scope user
```

If not installed yet, use `claude plugin install wellactually@wellactually --scope
user` instead of `update`. These examples assume a user-scoped installation;
check `claude plugin list --json` first if your installation uses another scope.

Start a fresh session in the selected host. Review changed hooks if Codex asks.
Check the installed plugin's `package.json` version against the requested version;
Codex's install result gives `installedPath`, and `claude plugin list --json`
gives `installPath`. If the host retained a cached version, uninstall/reinstall
the plugin in the same scope and verify again before testing. Do not edit cache
files or hook trust hashes. Exercise a real review and report results with the
exact version and host. For another candidate, regenerate this local catalog
with its new exact version and repeat the update/install.

## Return to the public marketplace

After either testing path, restore the GitHub marketplace. This returns to its
current exact pin, which may be older than the candidate. Start a fresh host
session afterward; already-running sessions can retain the previous plugin.

For **Codex**:

```sh
codex plugin marketplace remove wellactually
codex plugin marketplace add passsy/wellactually
codex plugin add wellactually@wellactually --json
```

For **Claude**, replace the local catalog, then uninstall/reinstall the
user-scoped plugin so a cached higher test version does not prevent a downgrade:

```sh
claude plugin marketplace add passsy/wellactually
claude plugin uninstall wellactually@wellactually --scope user
claude plugin install wellactually@wellactually --scope user
```

Use the original scope if it was not `user`. Check that the installed version
matches the public catalog. Review stores and credentials live outside the
plugin cache; leave them untouched. These steps do not delete the local test
artifacts, which existing sessions may still use.

The detector SDK is a separate package with its own version and release. See
[Detector SDK releases](../detector-sdk/PUBLISHING.md); a plugin-only change does not
require an SDK release.

## Maintainer release process

Publication and marketplace promotion are separate decisions. A candidate can
stay published on npm for testing without changing the public plugin pins.
There is no recurring release checker and no automatic continuation when you
approve on npm: the maintainer explicitly starts the promotion step.

### 1. Prepare and test locally

Use [Local testing without publishing](#local-testing-without-publishing) for
maintainer testing. Run the build and validation checks above, then merge the
intended changes into `main`. Choose a new exact version; never reuse a published
version, and never point the public marketplace at an unpublished version.
Local private `*.local.*` versions are for local tests, not npm publication.

### 2. Build and stage in GitHub Actions

Open [Actions → Release npm plugin](https://github.com/passsy/wellactually/actions/workflows/publish.yaml),
choose **Run workflow**, select `main`, enter the new exact `version`, and enable
`publish`. Despite its name, that input stages the package; it does not bypass
npm approval. Leave it off for a build-only rehearsal.

Actions builds/tests the package and exercises the same archive on the supported
Node versions. The separate stage job downloads that artifact, verifies its hash
and stages it with provenance using GitHub OIDC. It does not install dependencies
or execute the package. Only that job has `id-token: write`. Releases run serially.

A passing stage job means **awaiting approval**, not published. Its summary and
`wellactually-stage` artifact contain the stage ID and expected integrity. The
plugin package is staged under `next`; the detector SDK under `latest`.

### 3. Review and approve on npm

Open your npm account settings and choose **Staged Packages**.
Do not rely on an approval-request email. Check the package, version, publisher,
`next` tag and archive against the successful Actions run. You can inspect and
download it with `npm stage view <stage-id>` and `npm stage download <stage-id>`;
compare SHA-512 with the Actions `pack.json` before approval.

Click **Approve** on npm and complete 2FA, or run `npm stage approve <stage-id>`
and complete its interactive authentication. Approval publishes the archive and
moves `next`. Installs that follow the preview channel
(`shim.mjs update --channel next`) receive it on their next daily check; nobody
else does yet.

A rejected candidate must be corrected and staged under a new version. If an
upload fails, inspect any existing pending stage instead of blindly uploading
again: npm reserves staged versions. A successful approval command alone does
not prove that the archive is publicly downloadable.

### 4. Verify publication and optionally invite testers

Download the `wellactually-release` artifact from that exact Actions run into a
fresh directory. From the repository root, verify its `pack.json` against the
public npm metadata and downloaded bytes:

```sh
WELLACTUALLY_RELEASE_RUN=123456789 # Replace with the successful Actions run ID.
WELLACTUALLY_RELEASE_ARTIFACTS=$(mktemp -d)
gh run download "$WELLACTUALLY_RELEASE_RUN" --repo passsy/wellactually \
  --name wellactually-release --dir "$WELLACTUALLY_RELEASE_ARTIFACTS"
node --input-type=module - "$WELLACTUALLY_RELEASE_ARTIFACTS/pack.json" <<'JS'
import fs from "node:fs";
import { verifyPublishedPackage } from "./scripts/verify-package.mjs";
await verifyPublishedPackage(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
JS
```

The verifier makes bounded retries for registry propagation; it is not a
scheduled checker. Do not rebuild the archive to replace the expected integrity.
Keep the Actions run/version/integrity together as release evidence.

For outside feedback, send testers the exact version and
[Test a published npm version](#test-a-published-npm-version-before-marketplace-promotion).
Keep public catalog pins unchanged for as long as testing needs. A failed npm
candidate stays immutable; fix the source and publish a new version rather than
replacing its bytes. Existing plugin users stay on the previous pin.

### 5. Promote the verified version to plugin users

Claude Code and Codex plugins are frozen shells: `shim.mjs` runs the runtime
in `~/.wellactually/runtime`, which installs the newest `latest` release once a
day. OpenCode and pi run their hooks through the same shim. Moving `latest` is
therefore the rollout to every plugin user and to direct npm installs. A second
updater in `shim.mjs` installs the tag's release itself when the runtime's own
updater has not done so after two days, so a release with a broken updater
still gets replaced:

```sh
npm dist-tag add wellactually@<published-version> latest
```

Change the catalog pins only when the plugin shell itself changes (`shim.mjs`,
`hooks/hooks.json`, the manifests or the skills): every such change costs Codex
users one more `/hooks` approval. In that case, on a fresh branch from current
`main`, run:

```sh
node scripts/version.mjs <published-version>
npm install --package-lock-only --ignore-scripts
```

Review the exact pins in the shared Claude/Codex catalog, host manifests,
OpenCode and pi compatibility dependencies, and lockfile. Include any required
release documentation updates. Open a promotion PR, let its checks pass, then
merge it. Do not rebuild or republish the approved npm version. If other source
changes have landed since packaging, they are not part of this npm release.

Merging the pin promotion makes that version available through the public
marketplace update mechanisms. It does not change already-running sessions or
force every user to update immediately. Install/update from the public catalog
and verify the selected version. Test a real review, inbox accept/fix persistence
and, in hosts supporting it, live card updates. Claude inline cards remain
disabled; use the browser inbox there. Posting findings to a PR is a separate
explicit action. Verify natural fixed-event delivery after its grace/throttle
rather than fabricating a fix.

Codex requires a `/hooks` review after a catalog pin change because it fingerprints
the installed plugin. Do not write trust hashes programmatically. Review stores
and credentials remain outside plugin caches.

### One-time npm setup

Configure a trusted publisher for package `wellactually`, repository
`passsy/wellactually`, workflow `publish.yaml`, with no GitHub environment
restriction. Give it staging permission only; keep **Allow npm publish** disabled.
No permanent npm publishing token is required. Every staged version still needs
a maintainer's 2FA approval. This account setting lives on npm, outside the repo.

## Rollback

Move `latest` back with `npm dist-tag add wellactually@<previous-version> latest`;
frozen plugins install it on their next daily check. The target must be a
release that ships `shim.mjs`, 0.14.0 or later: both updaters refuse older
releases, which cannot update themselves. To go back to older code, publish it
again under a new version. For the catalog, pin it and both compatibility dependencies to a previously published
npm version, refresh the lockfile and push. To restore a historical Git-based
catalog, restore its built payload from the same historical revision too. Never
point a Git installer at a source-only tree without its npm adapter. Leave stored
findings and telemetry untouched.

## References

- [Codex npm sources](https://developers.openai.com/plugins/build/plugins)
- [Claude Code npm sources](https://code.claude.com/docs/en/plugins/marketplace-reference#npm-plugin-source)
- [OpenCode plugins](https://docs.dev.opencode.ai/docs/plugins/)
- [pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm staged publishing](https://docs.npmjs.com/staged-publishing/)
