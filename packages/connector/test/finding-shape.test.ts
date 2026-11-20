import { expect, test } from "vitest";
import { checkFindingShape } from "../../review-inbox/crud.mts";

test("finding descriptions must read as a news story, not one block", () => {
  const ok = [
    "`pubish()` → `publish()`",
    "The `StreamSubscription` from `listen()` is never cancelled, so it outlives the widget.",
    "A fixture can join the mesh after the app reports that pairing timed out. The timeout ends the app’s wait while provisioning continues. If cleanup checks mesh storage before the node is saved, the node can be left in the mesh without a fixture in the project.\n\nCancel provisioning at the transport and wait for it to stop before checking for a node to clean up and releasing the pairing lock.",
    "`MeshCommandQueue` can change behaviour without a single test failing.\n\nThe only queue tests count timestamps. Nothing asserts:\n\n- queued command identity\n- a dispatch error mid-drain\n\nAdd direct `MeshCommandQueue` tests asserting the ordered items.",
  ];
  for (const description of ok) expect(() => checkFindingShape(description)).not.toThrow();
  const block =
    "Deleting a fixture through a connected proxy can remove it from the project while leaving it in mesh storage. If the exclusion write fails, `MeshStorage.removeDevice` throws before deleting the node and Device Key. `BleManager.unprovisionDevice` swallows that failure, so `ProjectManager.removeNodes` deletes the project entry. Let local storage failures reach the caller.";
  expect(() => checkFindingShape(block)).toThrow(/own paragraph/);
  expect(() => checkFindingShape("A. B. C. D.\n\nFix it.")).toThrow(/news story/);
});
