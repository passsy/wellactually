/**
 * One line of tokens, rendered. Split from the tokenizer because a module
 * that exports a component exports only components, or fast refresh cannot
 * hot-swap it.
 */

import type { ReactNode } from "react";
import type { Tok } from "./highlight.ts";

/** One line of tokens, rendered. An empty line still takes up its height. */
export function Line({ toks }: { toks: Tok[] }): ReactNode {
  if (toks.length === 0) return " ";
  return toks.map((tok, index) =>
    tok.className ? (
      <span key={index} className={`tok-${tok.className}`}>
        {tok.text}
      </span>
    ) : (
      tok.text
    ),
  );
}
