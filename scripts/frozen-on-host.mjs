// Runs the frozen bundle of every detector API version on the host of an
// installed @wellactually/detector-sdk, the way the registry and the plugin run
// released principles. test-sdk-package.mjs copies this file into a project
// that has the packed archive installed, and passes the folder with the frozen
// versions (packages/core/test/api).
//
// It keeps the promises packages/core/test/api.test.ts checks against the
// source: each frozen bundle reports one finding for each thing its version
// promised, and an old version is never asked about what came after it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { apiOf, applies, fileCtx, mapProject, runDetector, textCtx, toolCtx } from "@wellactually/detector-sdk/host/node";

const dir = process.argv[2];
const frozen = (version) => JSON.parse(fs.readFileSync(path.join(dir, `v${version}/principle.json`), "utf8"));
const versions = fs
  .readdirSync(dir)
  .filter((name) => /^v\d+$/.test(name))
  .map((name) => Number(name.slice(1)))
  .sort((a, b) => a - b);

const session = ["// relative absolute shape alone fresh root reads", "class Session {", "  late User user;", "}"].join("\n");
const written = fileCtx("write", "lib/session.dart", session, {}, { isNew: true });
const project = mapProject("/project", { "pubspec.yaml": "name: app\n", "lib/session.dart": session });
const said = (findings) => findings.map((finding) => finding.match ?? `line ${finding.line}`);
const run = async (version, ctx) => {
  const { manifest, bundle } = frozen(version);
  const result = await runDetector(bundle, ctx, undefined, project, apiOf(manifest));
  assert.equal(result.error, null, `API ${version}: ${result.error}`);
  assert.deepEqual(result.dropped, [], `API ${version} dropped findings`);
  return result.findings;
};

const call = toolCtx("t3-code", "pull_request_create", { title: "Fix lost lines", body: "Why" });
const deletion = fileCtx("delete", "test/session_test.dart", ["void main() {", "  test('loads', () {});", "}"].join("\n"));

for (const version of versions) {
  const { manifest } = frozen(version);
  assert.equal(apiOf(manifest), version);
  // What every version still running promised: the write, the command and the output.
  assert.deepEqual(said(await run(version, written)), ["absolute", "shape", "fresh", "root", "reads", "line 3"], `API ${version} lost a promise on a write`);
  assert.deepEqual(await run(version, textCtx("command", "echo shape")), [{ match: "shape" }], `API ${version} lost a promise on a command`);
  assert.deepEqual(await run(version, textCtx("output", "Analyzing...\nshape of things", undefined, "dart analyze")), [{ line: 2, match: "shape" }], `API ${version} lost a promise on an output`);
  // A version is asked about a deletion from 4 on, and about a tool call from 5 on.
  assert.equal(applies(manifest, deletion), version >= 4, `API ${version} and deletions`);
  assert.equal(applies(manifest, call), version >= 5, `API ${version} and tool calls`);
  if (version >= 4) {
    assert.deepEqual(await run(version, deletion), [{}, { line: 2, removed: true, match: "test(" }], `API ${version} lost a promise on a deletion`);
  }
  if (version >= 5) {
    assert.deepEqual(await run(version, call), [{ depth: "pointer" }, { match: "Fix lost lines" }], `API ${version} lost a promise on a tool call`);
  }
}
console.log(`Ran the frozen bundles of detector API ${versions.join(", ")} on the installed host.`);
