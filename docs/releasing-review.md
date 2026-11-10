# npm distribution and releases

All four hosts install one prebuilt `wellactually` npm package. Git contains
source, native manifests and small compatibility adapters; it contains no
committed `dist/` trees or mirrored OpenCode/pi skills.

## Install paths

Claude Code and Codex retain the `wellactually@wellactually` identity. Their
shared `.claude-plugin/marketplace.json` entry names an exact published npm
version. A host fetches ready-to-run files without lifecycle scripts.

New OpenCode installs use `opencode plugin add wellactually`; pi uses
`pi install npm:wellactually`. Existing Git sources keep working: `opencode/`
exports and `compat/pi.mjs` import the `wellactually-runtime` npm alias. The Git
root pi manifest finds its namespaced skills in that dependency. Both aliases
pin the same published version as the catalog. They perform no downloads or
builds while the agent runs.

## Build and validate

Development tooling needs Node >=22.18. Installed packages support Node >=20.

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run web:test --workspace @wellactually/findings
npm run web:typecheck --workspace @wellactually/findings
npm run package -- --version <new-version>
npm run test:package
```

Development runtime output goes to ignored `dist/`; the npm archive and candidate
catalog go to ignored `.artifacts/`. Packaging reads authored skills and generates
both host layouts with tiny launchers for a single compiled review helper.

Packed-product tests install outside the checkout, offline with scripts disabled,
and exercise four host entrypoints, MCP CRUD, card/inbox assets, version identity,
PNG icons and compatibility adapter contracts. CI also tests the archive on Node
20.0.0. These checks do not establish actual desktop rendering or a complete review
in every host. Preserve those limits when describing a release.

## Publish, then promote

1. Build/test a new exact version. Never reuse a published version, and never
   put an unpublished version in active installer pointers.
2. Dispatch `publish.yaml` on `main`, supplying that version. Publishing defaults
   off; enabling it publishes the exact tested tarball with provenance. Prereleases
   use `next`; stable releases use `latest`.
3. Configure npm trusted publishing once: package `wellactually`, repository
   `passsy/wellactually`, workflow `publish.yaml`, no GitHub environment restriction, allowing
   direct publication. This is external account configuration; committing the
   workflow alone does not create that trust relationship. Alternatively an npm
   owner can publish the tested tarball manually through npm's 2FA flow.
4. Wait for registry availability and compare tarball integrity. npm can return
   HTTP 202 and print success while its registry still exposes only a placeholder.
   The release script verifies public metadata and downloaded archive bytes and
   fails rather than reporting an invisible version as released. Do not blindly
   republish when processing takes longer than the verification timeout.
5. After registry verification, run `node scripts/version.mjs <published-version>`
   and `npm install --package-lock-only --ignore-scripts`. Review the catalog,
   source manifests, both Git adapters and lockfile pins, then commit and push.
6. Test a fresh registry installation and a review in each advertised host,
   including card updates, accept/fix persistence and separately requested posting.
   Confirm natural fixed-event delivery after grace/throttle; never fabricate fixes.

The initial migration pins the verified `0.11.0-rc.1` artifact. The README-only
`rc.2` upload is not a reason to promote pointers until it is publicly available.
Existing local review stores and credentials are independent of plugin caches.
Codex may require one `/hooks` review after updates because it fingerprints the
whole installed plugin. Do not write trust hashes programmatically.

## Rollback

Pin the catalog and both compatibility dependencies to a previously published
npm version, refresh the lockfile and push. To restore a historical Git-based
catalog, restore its built payload from the same historical revision too. Never
point a Git installer at a source-only tree without its npm adapter. Leave stored
findings and telemetry untouched.

## Known validation limits

Native desktop UI rendering and a complete review in every host remain separate
from packed-product tests. OpenCode 2.2.5's bundled installer rejected the fresh
release under this machine's seven-day age policy despite npm's package-specific
exclusion. Standard npm installation and the prebuilt adapters pass; do not treat
that as a successful native OpenCode installation or disable the global age policy.
The dependency audit currently reports a low-severity
KaTeX advisory through Mermaid; its suggested major upgrade was unavailable under
the configured minimum release-age policy when the candidate was prepared.

## References

- [Codex npm sources](https://developers.openai.com/plugins/build/plugins)
- [Claude Code npm sources](https://code.claude.com/docs/en/plugins/marketplace-reference#npm-plugin-source)
- [OpenCode plugins](https://docs.dev.opencode.ai/docs/plugins/)
- [pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
