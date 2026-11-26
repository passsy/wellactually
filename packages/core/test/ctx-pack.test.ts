import vm from "node:vm";
import { describe, expect, test } from "vitest";
import { API_VERSION, type Ctx } from "@wellactually/detector-sdk";
import { ctxFor, environmentFor, fileCtx, MIN_API_VERSION, textCtx, toolCtx, UNPACK_CTX } from "../src/node.ts";

/** The event as the isolate rebuilds it from what `environmentFor` hands over. */
function unpacked(api: number, ctx: Ctx): unknown {
  return vm.runInNewContext(UNPACK_CTX, { ...environmentFor(api, ctx, null).strings });
}

const content = "import 'a.dart';\n\nvoid main() {\n  run();\n}\n";

const events: [string, Ctx][] = [
  ["a new file", fileCtx("write", "lib/a.dart", content)],
  ["an edit", fileCtx("write", "lib/a.dart", content, { written: [{ line: 4, text: "  run();" }], removed: [{ line: 4, text: "  walk();" }] })],
  ["a written line that is not the file's line", fileCtx("write", "lib/a.dart", content, { written: [{ line: 4, text: "  other();" }] })],
  ["a read", fileCtx("read", "lib/a.dart", content)],
  ["a delete", fileCtx("delete", "lib/a.dart", content)],
  ["windows line ends", fileCtx("write", "lib/a.dart", "a\r\nb\r\n")],
  ["an empty file", fileCtx("write", "lib/a.dart", "")],
  ["lines that do not split the content", { ...fileCtx("write", "lib/a.dart", content), file: { ...fileCtx("write", "lib/a.dart", content).file!, lines: ["other"] } }],
  ["text that is not the content", { ...fileCtx("write", "lib/a.dart", content), text: "something else" }],
  ["text that is not a string", { ...fileCtx("write", "lib/a.dart", content), text: null as unknown as string }],
  ["a NUL in the file", fileCtx("write", "lib/a.dart", "a\0b\n")],
  ["a NUL in a prompt", textCtx("prompt", "a\0b")],
  ["a U+0001 in the file", fileCtx("write", "lib/a.dart", "a\u0001b\n")],
  ["a prompt", textCtx("prompt", "Can we use freezed?\nplease")],
  ["a command", textCtx("command", "npm test")],
  ["a tool", toolCtx("t3-code", "pull_request_create", { title: "x" })],
];

describe("the event crosses into the isolate with the file in it once", () => {
  for (let api = MIN_API_VERSION; api <= API_VERSION; api++) {
    test.each(events)(`v${api}: %s comes out as it went in`, (_, ctx) => {
      // Through JSON, as the isolate saw it before: what a detector gets has to be exactly that.
      expect(JSON.stringify(unpacked(api, ctx))).toBe(JSON.stringify(ctxFor(api, ctx)));
    });
  }

  test("the file's text crosses once", () => {
    const big = "x".repeat(1000) + "\n";
    const strings = environmentFor(API_VERSION, fileCtx("write", "lib/a.dart", big.repeat(100)), null).strings;
    expect(strings.__ctx!.length).toBeLessThan(big.length * 110);
  });
});
