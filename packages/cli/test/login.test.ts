import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readConfig, writeConfig } from "../src/board/board.ts";
import { renderSync } from "../src/commands.ts";
import { finishDeviceLogin, sync } from "../src/registry/client.ts";

let home: string | undefined;
beforeEach(() => {
  home = process.env.WELLACTUALLY_HOME;
  process.env.WELLACTUALLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wa-login-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (home === undefined) {
    delete process.env.WELLACTUALLY_HOME;
  } else {
    process.env.WELLACTUALLY_HOME = home;
  }
});

test("a login keeps waiting when a poll gets no answer", async () => {
  const answers: Array<() => Response> = [
    () => {
      throw new TypeError("fetch failed");
    },
    () => new Response("", { status: 500 }),
    () => Response.json({ status: "pending" }, { status: 202 }),
    () => Response.json({ token: "token-1", handle: "passsy" }),
  ];
  const fetch = vi.fn(async () => answers.shift()!());
  vi.stubGlobal("fetch", fetch);

  const handle = await finishDeviceLogin({ device_code: "device", user_code: "ABCD-EFGH", verification_url: "https://wellactually.dev/device", interval: 0, expires_in: 60 });

  expect(handle).toBe("passsy");
  expect(readConfig().token).toBe("token-1");
  expect(fetch).toHaveBeenCalledTimes(4);
});

test("a login stops when the code expired", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ error: "The code expired. Sign in again with the plugin's login skill." }, { status: 410 }));

  await expect(finishDeviceLogin({ device_code: "device", user_code: "ABCD-EFGH", verification_url: "https://wellactually.dev/device", interval: 0, expires_in: 60 })).rejects.toThrow("The code expired");
});

test("a sync of an empty advisory board lists the experts to add, with their pages", async () => {
  writeConfig({ ...readConfig(), token: "token-1", registry: "https://wellactually.dev" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ entries: [], suggestions: [{ handle: "passsy", name: "Pascal Welsch", principles: 12, tips: ["Avoid Conventional Commits", "Good Commit Messages"] }] })),
  );

  const result = await sync();

  expect(result.suggestions).toEqual([expect.objectContaining({ handle: "passsy", url: "https://wellactually.dev/e/passsy" })]);
  expect(renderSync(result)).toBe(
    [
      "0 principles on your advisory board, 0 enabled. Downloaded 0, removed 0.",
      "",
      "Your advisory board is empty. Experts you can follow:",
      "  Pascal Welsch (@passsy), 12 principles: Avoid Conventional Commits; Good Commit Messages",
      "    https://wellactually.dev/e/passsy",
      "",
      "Follow the ones you like on their page, then sync again.",
    ].join("\n"),
  );
});

test("a token in WELLACTUALLY_TOKEN signs in without a login and is never written to disk", async () => {
  vi.stubEnv("WELLACTUALLY_TOKEN", "ci-token");
  try {
    const fetch = vi.fn(async (_url: URL, _init: RequestInit) => Response.json({ entries: [] }));
    vi.stubGlobal("fetch", fetch);

    await sync();
    writeConfig({ ...readConfig(), stats: false });

    expect(new Headers(fetch.mock.calls[0]?.[1].headers).get("authorization")).toBe("Bearer ci-token");
    const stored = JSON.parse(fs.readFileSync(path.join(process.env.WELLACTUALLY_HOME!, "config.json"), "utf8")) as { token: string | null; stats: boolean };
    expect(stored).toMatchObject({ token: null, stats: false });
  } finally {
    vi.unstubAllEnvs();
  }
});

test("a token in WELLACTUALLY_TOKEN wins over a login, which stays stored", async () => {
  writeConfig({ ...readConfig(), token: "login-token", handle: "passsy" });
  vi.stubEnv("WELLACTUALLY_TOKEN", "ci-token");
  try {
    expect(readConfig().token).toBe("ci-token");
    writeConfig(readConfig());
  } finally {
    vi.unstubAllEnvs();
  }
  expect(readConfig().token).toBe("login-token");
});

test("a revoked WELLACTUALLY_TOKEN says where to get a new one", async () => {
  vi.stubEnv("WELLACTUALLY_TOKEN", "revoked");
  try {
    vi.stubGlobal("fetch", async () => Response.json({ error: "Not signed in." }, { status: 401 }));
    await expect(sync()).rejects.toThrow("WELLACTUALLY_TOKEN");
  } finally {
    vi.unstubAllEnvs();
  }
});
