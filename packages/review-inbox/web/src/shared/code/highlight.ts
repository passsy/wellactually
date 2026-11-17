/**
 * Syntax colour for every place the pages show code.
 *
 * One tokenizer feeding three renderers — the chunks under a finding, the
 * file panel, and the markdown fences — so code is the same colours wherever
 * it appears, including in the generated report, which renders in Node.
 * refractor rather than Prism itself for exactly that reason: it is the same
 * grammars behind a module interface, with no global and no document.
 *
 * The renderers draw code line by line — line numbers, bands, anchors — so
 * the API here is lines of tokens rather than a block of HTML: the whole text
 * is tokenized at once, which is what keeps a doc comment or a multi-line
 * string coloured past its first line, and the tokens are then cut at every
 * newline.
 */

import { refractor } from "refractor/core";
export { languageOf } from "../../../../model/language.mts";
import type { RootContent } from "hast";
import bash from "refractor/bash";
import css from "refractor/css";
import dart from "refractor/dart";
import diff from "refractor/diff";
import javascript from "refractor/javascript";
import json from "refractor/json";
import jsx from "refractor/jsx";
import markdown from "refractor/markdown";
import markup from "refractor/markup";
import python from "refractor/python";
import c from "refractor/c";
import cpp from "refractor/cpp";
import csharp from "refractor/csharp";
import docker from "refractor/docker";
import go from "refractor/go";
import graphql from "refractor/graphql";
import groovy from "refractor/groovy";
import ini from "refractor/ini";
import java from "refractor/java";
import kotlin from "refractor/kotlin";
import objectivec from "refractor/objectivec";
import php from "refractor/php";
import properties from "refractor/properties";
import ruby from "refractor/ruby";
import rust from "refractor/rust";
import scss from "refractor/scss";
import sql from "refractor/sql";
import swift from "refractor/swift";
import toml from "refractor/toml";
import tsx from "refractor/tsx";
import typescript from "refractor/typescript";
import yaml from "refractor/yaml";

for (const language of [
  markup,
  bash,
  css,
  dart,
  diff,
  javascript,
  json,
  jsx,
  markdown,
  python,
  c,
  cpp,
  csharp,
  docker,
  go,
  graphql,
  groovy,
  ini,
  java,
  kotlin,
  objectivec,
  php,
  properties,
  ruby,
  rust,
  scss,
  sql,
  swift,
  toml,
  tsx,
  typescript,
  yaml,
]) {
  refractor.register(language);
}

/** A stretch of one colour. Null class is plain text in the code colour. */
export interface Tok {
  className: string | null;
  text: string;
}

/**
 * Whether a grammar is actually loaded.
 *
 * The map from a file name to a language name and the list of grammars that
 * were imported are two separate lists, and a name in the first that is
 * missing from the second is invisible: the code renders in one colour, which
 * is what a file with nothing to highlight looks like anyway. This is how a
 * test can tell those two apart.
 */
export function registered(language: string): boolean {
  return refractor.registered(language);
}

/** Fence names people actually write, folded onto the registered grammars. */
const ALIAS: Record<string, string> = {
  shell: "bash",
  console: "bash",
  htm: "markup",
  html: "markup",
  xml: "markup",
  yml: "yaml",
  js: "javascript",
  ts: "typescript",
  mts: "typescript",
  py: "python",
  rb: "ruby",
  kt: "kotlin",
  golang: "go",
  "c++": "cpp",
  "objective-c": "objectivec",
  dockerfile: "docker",
};

/**
 * The text, tokenized and cut into lines.
 *
 * An unknown or absent language degrades to plain lines rather than to an
 * error: a fence labelled with a tool's name nobody wrote a grammar for is
 * still code somebody wants to read.
 */
export function tokenLines(code: string, language: string | null): Tok[][] {
  const wanted = language ? (ALIAS[language] ?? language) : null;
  if (!wanted || !refractor.registered(wanted)) {
    return code
      .split("\n")
      .map((text) => (text ? [{ className: null, text }] : []));
  }
  const lines: Tok[][] = [[]];
  const walk = (nodes: RootContent[], className: string | null): void => {
    for (const node of nodes) {
      if (node.type === "text") {
        const parts = node.value.split("\n");
        parts.forEach((part, index) => {
          if (index > 0) lines.push([]);
          if (part) lines[lines.length - 1]?.push({ className, text: part });
        });
      } else if (node.type === "element") {
        const names = Array.isArray(node.properties.className)
          ? node.properties.className
          : [];
        // ["token", "keyword"] — the second name is the one that carries the
        // meaning, and the most deeply nested one wins.
        const own = names.filter((name) => name !== "token")[0];
        walk(node.children, typeof own === "string" ? own : className);
      }
    }
  };
  walk(refractor.highlight(code, wanted).children, null);
  return lines;
}
