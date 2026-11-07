/**
 * What a path says a file is written in.
 *
 * The part of highlighting that fails silently. A grammar that is missing or
 * unmapped does not throw and does not look broken — the code simply arrives
 * in one colour, which is also what a file with nothing to highlight looks
 * like. Python was unmapped for as long as this page has existed, against
 * forty-four findings on the machine it was written on, and nobody could see
 * it from the outside.
 */

import { describe, expect, test } from "vitest";
import { languageOf, registered, tokenLines } from "./highlight.ts";

describe("what a file is written in", () => {
  test("reads the languages a mobile checkout is made of", () => {
    // Every one of these is in a repository this has been used to review.
    expect(languageOf("lib/main.dart")).toBe("dart");
    expect(languageOf("src/app/service.py")).toBe("python");
    expect(languageOf("ios/Runner/AppDelegate.swift")).toBe("swift");
    expect(languageOf("android/app/src/main/kotlin/Main.kt")).toBe("kotlin");
    expect(languageOf("android/app/build.gradle")).toBe("groovy");
    expect(languageOf("gradle.properties")).toBe("properties");
  });

  test("knows the files whose name is the whole of their type", () => {
    // No dot to take an extension from, and all of them real code.
    expect(languageOf("ios/Podfile")).toBe("ruby");
    expect(languageOf("fastlane/Fastfile")).toBe("ruby");
    expect(languageOf("Dockerfile")).toBe("docker");
    // A name that merely starts the same way is not one of them.
    expect(languageOf("Podfile.lock")).toBeNull();
  });

  test("sends the XML family to the grammar it already had", () => {
    // These needed no new grammar and were reaching none: an iOS checkout
    // carries hundreds of them.
    for (const path of [
      "assets/logo.svg",
      "ios/Runner/Info.plist",
      "ios/Runner/Base.lproj/Main.storyboard",
      "ios/Runner.xcodeproj/xcshareddata/xcschemes/Runner.xcscheme",
    ]) {
      expect(languageOf(path)).toBe("markup");
    }
  });

  test("gives a header the language its three claimants agree on", () => {
    // .h is C, C++ or Objective-C depending on the file, and picking one of
    // them means being wrong about most of them.
    expect(languageOf("Runner-Bridging-Header.h")).toBe("c");
    expect(languageOf("core/util.cpp")).toBe("cpp");
    expect(languageOf("Runner/AppDelegate.m")).toBe("objectivec");
  });

  test("a file with nothing to say is plain, not an error", () => {
    expect(languageOf("notes.txt")).toBeNull();
    expect(languageOf("LICENSE")).toBeNull();
    // And an unknown language degrades to lines rather than throwing.
    expect(tokenLines("some text\nand more", "brainfuck")).toEqual([
      [{ className: null, text: "some text" }],
      [{ className: null, text: "and more" }],
    ]);
  });

  test("every language it names is actually registered", () => {
    // The map and the register list are two places, and a name in one that is
    // missing from the other is exactly the failure this file exists for.
    const paths = [
      "a.dart",
      "a.py",
      "a.swift",
      "a.kt",
      "a.java",
      "a.m",
      "a.h",
      "a.cpp",
      "a.cs",
      "a.go",
      "a.rs",
      "a.rb",
      "a.php",
      "a.sql",
      "a.gradle",
      "a.graphql",
      "a.scss",
      "a.toml",
      "a.ini",
      "a.properties",
      "a.svg",
      "a.ts",
      "a.tsx",
      "a.js",
      "a.json",
      "a.yaml",
      "a.md",
      "a.sh",
      "a.css",
      "Dockerfile",
      "Podfile",
    ];
    const unregistered = paths
      .map((path) => ({ path, language: languageOf(path) }))
      .filter(({ language }) => language === null || !registered(language));

    expect(unregistered).toEqual([]);
  });
});
