import { onWrite } from "@wellactually/sdk/v3";

// Anchored at the start of the line, so an enum in a comment or a string is not one.
const ENUM = /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+[A-Za-z_$]/;

// A declaration file describes someone else's enum. There is nothing to rewrite.
onWrite({
  globs: ["**/*.{ts,tsx,mts,cts}", "!**/*.d.{ts,mts,cts}"],
  *detect(event) {
    for (const written of event.written) {
      if (ENUM.test(written.text)) {
        yield { line: written.line };
      }
    }
  },
});
