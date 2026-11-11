/** A successful stage upload is awaiting approval, not a published release. */
export function stagedReceipt(output, packed) {
  const response = JSON.parse(output);
  const staged = response[packed.name];
  if (!staged || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(staged.stageId ?? "")) {
    throw new Error("npm did not return a staged package ID; do not claim a release");
  }
  if (staged.name !== packed.name || staged.version !== packed.version || staged.integrity !== packed.integrity) {
    throw new Error("Staged package differs from the tested archive");
  }
  return { state: "staged", name: packed.name, version: packed.version, integrity: packed.integrity, stageId: staged.stageId };
}
