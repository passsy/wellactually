import { describe, expect, test } from "vitest";
import { mentioned } from "@wellactually/sdk";

describe("mentioned", () => {
  const said = (text: string, names: string[]) => mentioned({ text }, names);

  test("finds a name where it stands alone, as it was written", () => {
    expect(said("Should we use RxDart here?", ["rxdart"])).toEqual([{ match: "RxDart", depth: "pointer" }]);
    expect(said("add rx_dart to the pubspec", ["rxdart"])).toEqual([{ match: "rx_dart", depth: "pointer" }]);
    expect(said("the late   final field", ["late final"])).toEqual([{ match: "late   final", depth: "pointer" }]);
  });

  test("stays quiet on a name inside another word", () => {
    expect(said("we need a blocker", ["bloc"])).toEqual([]);
    expect(said("Prüfe das", ["pr"])).toEqual([]);
    expect(said("call user.late now", ["late"])).toEqual([]);
  });

  test("reports the first name that occurs, once", () => {
    expect(said("freezed and build_runner", ["build_runner", "freezed"])).toEqual([{ match: "build_runner", depth: "pointer" }]);
  });

  test("leaves the match out when the name is broken over two lines", () => {
    expect(said("conventional\ncommits", ["conventional commits"])).toEqual([{ depth: "pointer" }]);
  });
});
