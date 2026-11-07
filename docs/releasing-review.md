# Shipping the review skill

Ship one prebuilt **`wellactually` npm package**. Claude Code and Codex retain the
`wellactually@wellactually` marketplace identity. OpenCode loads the package's
server/TUI exports; pi loads its declared extension and namespaced skills. Every
host uses the same command, findings store, review helper and web assets.

This follows the release direction agreed in the review thread: source-only
`main`, generated artifacts in npm, one version and native host adapters. There
is no second hooks plugin, release branch or build during installation.

## What is ready

`npm run package -- --version 0.11.0-rc.1` builds `.artifacts/package/`, packs it,
and writes `.artifacts/pack.json` plus an **inactive** candidate marketplace.
`npm run test:package` installs that tarball offline with `--ignore-scripts` into
a temporary directory outside this repository. It exercises the skill helper,
all host entrypoints, MCP finding/occurrence creation, card and inbox assets,
and the installed server version. No project credentials or real review stores
are used. Normal backend/UI tests remain separate.

Only authored skill Markdown, manifests, hooks and compiled runtime/assets enter
the archive. There are no workspaces, runtime npm dependencies or lifecycle
scripts. Both skill layouts have tiny launchers for one compiled review helper.
The orchestration source stays under `skills/review/scripts/`.

Build tooling uses Node >=22.18. The installed product retains the documented
Node >=20 runtime floor. Test the packed product at that floor too: the new icon
encoder previously imported `zlib.crc32`, which Node 20 lacks and which prevented
the entire MCP process from starting. Its portable PNG checksum encoder now
avoids that dependency.

The `Packed plugin` workflow builds and tests the tarball on pull requests. The
manual `release.yml` workflow rebuilds/tests before publishing the exact tested
tarball, with provenance, using npm trusted publishing. Publishing defaults off;
prereleases use `next`, stable releases use `latest`.

## Release sequence

1. Finish the candidate on the review branch, retaining the current Git catalog
   and generated Git-install payload until the registry package is available.
   Do not make the current `source: "./"` catalog point at a source-only tree.
2. Bootstrap ownership of the npm package. At the time of preparation, `npm view
   wellactually` returned 404 and this machine was not logged in. Confirm the
   final name/ownership, then an npm owner can publish the tested prerelease with
   `npm publish .artifacts/wellactually-0.11.0-rc.1.tgz --ignore-scripts --access public --tag next`.
   Credentials must stay in npm's login flow, not repository files or chat.
3. In npm package settings, authorize GitHub **passsy/wellactually**, workflow
   **release.yml**, environment **npm**, allowing direct publication. Configure
   the GitHub environment's reviewers as desired. This removes the need for a
   long-lived publish token. Use npm >=11.5.1 and Node >=22.14 for publishing.
4. Download/install the **registry** prerelease, then perform a fresh review in
   each supported harness. Test card startup/update, accept/fix persistence,
   posting as a separate explicit user action, and natural fixed-event delivery
   after grace/throttle. Adapter/manifest tests do not establish desktop UI
   rendering. Do not fabricate code fixes or stats to pass this gate.
5. Publish the final exact stable artifact. Verify it is fetchable, then commit
   the generated npm `source` entry to `.claude-plugin/marketplace.json` (Codex
   also accepts this catalog). Keep name, owner and existing plugin identity.
   Advertise the **tested harness versions**, not an unverified minimum version.
6. In the same catalog-switch change, remove tracked `dist/`, `opencode/dist/`,
   `opencode/skills/` and generated `skills/review/scripts/*.mjs` from Git; ignore
   them, retain their TypeScript sources, and replace the generated-file drift
   check with the packed-artifact gate. Change OpenCode/pi install instructions
   to the npm source. Apply `.artifacts/git-compat/` as well: the root pi manifest
   loads a small `compat/pi.mjs`, and OpenCode's Git subpackage keeps its original
   exports. Both depend on `wellactually-runtime: npm:wellactually@<exact-version>`
   and load the same published artifact. Existing Git users can keep their source
   and update normally; no runtime downloader or installer build is introduced.
   Regenerate the lockfile for this dependency after publication. Test both old
   Git install sources against the registry before removing the legacy payload.
   Do not remove the legacy build path before this switch.
7. Merge PR #8 with its title/body rewritten for the actual queue/CRUD workflow.
   Existing installs keep their local review stores and credentials. Tell Codex
   users to review the six hooks once: Codex fingerprints the whole plugin, so
   a README-only update can still invalidate trust. No trust hashes are edited.

For rollback, restore the previous Git catalog **and** its built payload together,
or pin the catalog to a previously published good npm version. Never restore a
Git source pointing at a tree whose bundles have been removed. Leave stored
findings and telemetry untouched.

## Remaining gates

- Initial npm ownership/publication and trusted-publisher configuration are
  external setup; a locally packed tarball is not a published release.
- The npm artifact needs actual registry installation and a review in each
  advertised desktop/terminal host. Local adapter smoke tests are narrower.
- Compatible lockfile updates address the audit's high/moderate advisories. A
  low-severity KaTeX advisory remains through Mermaid; npm's suggested major
  upgrade was unavailable under the configured minimum release-age policy.
  Reassess the eligible patched dependency before promoting the prerelease.
- Source-only Git cleanup and active catalog changes intentionally follow the
  registry gate. Until then the existing Git distribution stays intact.

## References

- [Codex npm plugin sources](https://developers.openai.com/plugins/build/plugins)
- [Claude Code npm plugin sources](https://code.claude.com/docs/en/plugins/marketplace-reference#npm-plugin-source)
- [OpenCode plugins](https://docs.dev.opencode.ai/docs/plugins/)
- [pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [Ponytail's shared package manifest](https://github.com/DietrichGebert/ponytail/blob/main/package.json)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
