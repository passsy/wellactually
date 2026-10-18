import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readConfig, writeConfig, writeLockfile } from "../src/board.ts";
import { describeCredits, principleIdOf, renderShow, showPrinciple } from "../src/commands.ts";

const ADVICE = "# Avoid late\n\nInitialize fields where they are declared instead of marking them late.\n\nSee [Prefer final](https://wellactually.dev/p/passsy/prefer-final).";

let home: string | undefined;
beforeEach(() => {
  home = process.env.WELLACTUALLY_HOME;
  process.env.WELLACTUALLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wa-show-"));
  writeConfig({ ...readConfig(), registry: "https://wellactually.dev", token: "token-1", handle: "passsy" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (home === undefined) {
    delete process.env.WELLACTUALLY_HOME;
  } else {
    process.env.WELLACTUALLY_HOME = home;
  }
});

/** A registry that knows the given principles, by `expert/principle`, and answers 404 for the rest like the real one. */
function registryWith(principles: Record<string, object>) {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      asked.push(`${url.pathname}${url.search}`);
      const [, , , handle, slug] = url.pathname.split("/");
      const principle = principles[`${handle}/${slug}`];
      if (!principle) {
        return Response.json({ error: `No principle ${handle}/${slug}, or it is private.` }, { status: 404 });
      }
      return Response.json(principle);
    }),
  );
  return asked;
}

function source(id: string, extra: object = {}) {
  return { id, version: 4, status: "released", files: { "principle.md": ADVICE, "package.json": '{"tags": ["dart", "flutter"]}' }, credits: [id.split("/")[0]], visibility: "public", ...extra };
}

describe("a principle reference", () => {
  test("is an id as it is", () => {
    expect(principleIdOf("passsy/avoid-late")).toBe("passsy/avoid-late");
    expect(principleIdOf("passsy/avoid-late@3")).toBe("passsy/avoid-late@3");
    expect(principleIdOf("avoid-late")).toBe("avoid-late");
  });

  test("is a link to its page, with or without a scheme", () => {
    expect(principleIdOf("https://wellactually.dev/p/passsy/avoid-late")).toBe("passsy/avoid-late");
    expect(principleIdOf("wellactually.dev/p/passsy/avoid-late/")).toBe("passsy/avoid-late");
    expect(principleIdOf("https://wellactually.dev/p/passsy/avoid-late?v=3#advice")).toBe("passsy/avoid-late@3");
    expect(principleIdOf("https://wellactually.dev/p/passsy/avoid-late/edit")).toBe("passsy/avoid-late");
  });

  test("is not a link to another site", () => {
    expect(() => principleIdOf("https://example.com/p/passsy/avoid-late")).toThrow("is not a link to a principle on wellactually.dev");
    expect(() => principleIdOf("https://wellactually.dev/p/passsy")).toThrow("does not name a principle");
  });
});

describe("showing a principle", () => {
  test("prints its advice with author, tags, visibility and link", async () => {
    const asked = registryWith({ "passsy/avoid-late": source("passsy/avoid-late") });

    const shown = await showPrinciple("https://wellactually.dev/p/passsy/avoid-late");

    expect(asked).toEqual(["/api/principles/passsy/avoid-late/source"]);
    expect(renderShow(shown)).toBe(
      [
        "passsy/avoid-late (revision 4)",
        "Author: @passsy",
        "Visibility: public",
        "Tags: dart, flutter",
        "Link: https://wellactually.dev/p/passsy/avoid-late",
        "",
        ADVICE,
      ].join("\n"),
    );
  });

  test("asks for the revision a link or id names", async () => {
    const asked = registryWith({ "passsy/avoid-late": source("passsy/avoid-late") });
    await showPrinciple("https://wellactually.dev/p/passsy/avoid-late?v=2");
    await showPrinciple("passsy/avoid-late@2");
    expect(asked).toEqual(["/api/principles/passsy/avoid-late/source?version=2", "/api/principles/passsy/avoid-late/source?version=2"]);
  });

  test("names the forks and an unreleased draft", async () => {
    registryWith({ "ana/avoid-late": source("ana/avoid-late", { status: "draft", credits: ["passsy", "ana"], visibility: "private", files: { "principle.md": ADVICE } }) });

    const lines = renderShow(await showPrinciple("ana/avoid-late")).split("\n");

    expect(lines.slice(0, 4)).toEqual(["ana/avoid-late (draft of revision 4, not released)", "Author: @passsy, edited by @ana", "Visibility: private", "Tags: none"]);
  });

  test("reads a bare name as one of the user's own first", async () => {
    writeLockfile({ syncedAt: null, entries: [{ id: "ana/avoid-late", version: 1, hash: "h", enabled: true }] });
    const asked = registryWith({ "passsy/avoid-late": source("passsy/avoid-late"), "ana/avoid-late": source("ana/avoid-late") });

    expect((await showPrinciple("avoid-late")).id).toBe("passsy/avoid-late");
    expect(asked).toEqual(["/api/principles/passsy/avoid-late/source"]);
  });

  test("reads a bare name from the advisory board when the user has none by that name", async () => {
    writeLockfile({ syncedAt: null, entries: [{ id: "ana/prefer-final", version: 1, hash: "h", enabled: true }] });
    const asked = registryWith({ "ana/prefer-final": source("ana/prefer-final") });

    expect((await showPrinciple("prefer-final@2")).id).toBe("ana/prefer-final");
    expect(asked).toEqual(["/api/principles/passsy/prefer-final/source?version=2", "/api/principles/ana/prefer-final/source?version=2"]);
  });

  test("asks for the expert when the board has several by that name", async () => {
    writeLockfile({
      syncedAt: null,
      entries: [
        { id: "ana/prefer-final", version: 1, hash: "h", enabled: true },
        { id: "bo/prefer-final", version: 1, hash: "h", enabled: true },
      ],
    });
    registryWith({});

    await expect(showPrinciple("prefer-final")).rejects.toThrow("Several principles are named prefer-final: ana/prefer-final, bo/prefer-final.");
  });

  test("says so when nothing by that name can be seen, a private one of someone else included", async () => {
    registryWith({});
    await expect(showPrinciple("prefer-final")).rejects.toThrow("You have no principle named prefer-final, and none on your advisory board is.");
    await expect(showPrinciple("bo/secret")).rejects.toThrow("No principle bo/secret, or it is private.");
  });

  test("does not take a failing registry for a missing principle", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "too many requests" }, { status: 429 }));
    await expect(showPrinciple("prefer-final")).rejects.toThrow("too many requests");
  });
});

describe("the credits of a pulled principle", () => {
  test("name the original expert and everyone who edited it on the way", () => {
    expect(describeCredits(["expert"])).toBeNull();
    expect(describeCredits(["passsy", "john"])).toBe("Original by @passsy, edited by @john");
    expect(describeCredits(["passsy", "john", "jimmy"])).toBe("Original by @passsy, edited by @john and @jimmy");
    expect(describeCredits(["passsy", "ann", "john", "jimmy"])).toBe("Original by @passsy, edited by @ann, @john and @jimmy");
  });
});
