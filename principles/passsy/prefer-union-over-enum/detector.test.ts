import { expect, test } from "vitest";
import { detect, edit, source, write } from "@wellactually/sdk/test";

const status = source`
  export enum Status {
    Draft = "draft",
    Released = "released",
  }

  export const DEFAULT_PAGE_SIZE = 20;
`;

test("fires on an enum the agent writes", () => {
  expect(detect(write("src/status.ts", status))).toEqual([{ line: 1, evidence: "export enum Status {" }]);
});

test("fires on a const enum", () => {
  const code = source`
    const enum Direction {
      Up,
      Down,
    }
  `;
  expect(detect(write("src/direction.ts", code))).toEqual([{ line: 1, evidence: "const enum Direction {" }]);
});

test("stays quiet on an enum that was already there when the agent edits another line", () => {
  expect(detect(edit("src/status.ts", status, { written: "export const DEFAULT_PAGE_SIZE = 20;" }))).toEqual([]);
});

test("stays quiet on a union of literals", () => {
  const code = source`
    export type Status = "draft" | "released";

    export const STATUSES = ["draft", "released"] as const;
  `;
  expect(detect(write("src/status.ts", code))).toEqual([]);
});

test("stays quiet on enum in a comment, a string or another word", () => {
  const code = source`
    // enum Status was replaced by a union.
    const enumerate = (items: string[]) => items.entries();
    const label = "enum Status {";
  `;
  expect(detect(write("src/label.ts", code))).toEqual([]);
});

test("stays quiet in a declaration file", () => {
  const code = source`
    export declare enum VendorMode {
      Fast,
      Safe,
    }
  `;
  expect(detect(write("types/vendor.d.ts", code))).toEqual([]);
});
