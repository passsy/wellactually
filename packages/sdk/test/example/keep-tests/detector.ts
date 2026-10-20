import { onDelete, onWrite, type RemovedLine } from "@wellactually/sdk/v4";

const TEST_FILES = ["**/*_test.dart", "**/*.test.ts", "**/test_*.py"];

/** The name a test is declared with, as in test('loads', ...) or it("saves", ...). */
function testName(text: string): string | null {
  const declared = /\b(?:test|it|testWidgets)\(\s*(["'`])(.*?)\1/.exec(text);
  if (declared === null) {
    return null;
  }
  return declared[2] ?? null;
}

onWrite({
  globs: TEST_FILES,
  *detect(event) {
    // A test that was rewritten under the same name was changed, not removed.
    const kept = new Set<string>();
    for (const written of event.written) {
      const name = testName(written.text);
      if (name !== null) {
        kept.add(name);
      }
    }
    for (const removed of event.removed) {
      const name = testName(removed.text);
      if (name !== null && !kept.has(name)) {
        yield removed;
      }
    }
  },
});

onDelete({
  globs: TEST_FILES,
  *detect(event) {
    const declared: RemovedLine[] = [];
    for (const removed of event.removed) {
      if (testName(removed.text) !== null) {
        declared.push(removed);
      }
    }
    if (declared.length > 0) {
      yield {};
    }
  },
});
