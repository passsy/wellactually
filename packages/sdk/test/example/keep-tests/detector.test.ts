import { expect, test } from "vitest";
import { deleted, detect, edit, source, write } from "@wellactually/sdk/v4/test";

const before = source`
  void main() {
    test('loads', () {});
    test('saves', () {});
  }
`;

test("fires on a test the agent removed, at the line it had", () => {
  const after = source`
    void main() {
      test('loads', () {});
    }
  `;
  expect(detect(edit("test/store_test.dart", after, { removed: "  test('saves', () {});", before }))).toEqual([{ line: 3, removed: true }]);
});

test("stays quiet on a test that was rewritten under its name", () => {
  const after = source`
    void main() {
      test('loads', () {});
      test('saves', () { expect(store.saved, isTrue); });
    }
  `;
  const change = { written: "  test('saves', () { expect(store.saved, isTrue); });", removed: "  test('saves', () {});", before };
  expect(detect(edit("test/store_test.dart", after, change))).toEqual([]);
});

test("fires on a deleted test file", () => {
  expect(detect(deleted("test/store_test.dart", before))).toEqual([{}]);
});

test("stays quiet on a deleted file that is no test", () => {
  expect(detect(deleted("lib/store.dart", "class Store {}"))).toEqual([]);
  expect(detect(deleted("test/helpers_test.dart", "void helper() {}"))).toEqual([]);
});

test("stays quiet on a new test file", () => {
  expect(detect(write("test/store_test.dart", before))).toEqual([]);
});

test("an edit without the file before cannot say where a removed line was", () => {
  expect(() => edit("test/store_test.dart", "void main() {}", { removed: "  test('saves', () {});" })).toThrow("pass the file as it was before the edit as before");
});
