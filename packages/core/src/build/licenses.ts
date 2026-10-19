import type { PackageFiles } from "./packages.ts";

/**
 * The licences of the packages a detector takes in.
 *
 * The code of a package becomes part of the bundle, and the bundle goes to
 * every machine that uses the principle. That is distribution, so the bundle
 * carries the licence of every package in it, and a package whose licence
 * asks for more than that is only taken when the expert said so.
 *
 * What a package is licensed under is read from two places that have to
 * agree: the `license` of its package.json, and the licence file that lies in
 * the package. A package.json alone is a claim. When the file is missing or
 * is the text of another licence, the licence is not known.
 */

/** The licences that ask for no more than their text and the copyright lines to travel with the code. */
export const PERMISSIVE_LICENSES = ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Apache-2.0", "Zlib", "Unlicense", "CC0-1.0", "BlueOak-1.0.0", "Python-2.0"];

/** What a package is licensed under, as far as its files show. */
export interface Licensing {
  /**
   * The licence the code is taken under, as an SPDX expression: of
   * `MIT OR GPL-3.0-only` the branch that was chosen. Empty when the package
   * names none that can be read.
   */
  spdx: string;
  /**
   * Why the expert has to approve the package, in words for them. Empty when
   * the licence passes by itself.
   */
  review: string;
  /** The licence files of the package, as they lie in it. */
  texts: LicenseFile[];
  /** Its NOTICE files, which the Apache licence asks to pass on. */
  notices: LicenseFile[];
  /** The copyright lines of those files, each once. */
  copyright: string[];
}

export interface LicenseFile {
  /** The name of the file in the package. */
  name: string;
  text: string;
}

const LICENSE_FILE = /^(?:licen[sc]e|copying|unlicense)(?:[.-][\w.-]*)?$/i;
const NOTICE_FILE = /^notice(?:[.-][\w.-]*)?$/i;

/**
 * The names a licence file goes by. A source of packages is asked for each,
 * because it can answer for a file and cannot list a folder.
 */
export const LICENSE_FILE_NAMES = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENCE",
  "LICENCE.md",
  "LICENCE.txt",
  "license",
  "license.md",
  "license.txt",
  "LICENSE-MIT",
  "LICENSE-MIT.txt",
  "LICENSE-APACHE",
  "LICENSE-APACHE.txt",
  "LICENSE.MIT",
  "LICENSE.APACHE2",
  "LICENSE.BSD",
  "COPYING",
  "COPYING.md",
  "COPYING.txt",
  "UNLICENSE",
  "NOTICE",
  "NOTICE.md",
  "NOTICE.txt",
];

/** A licence expression: one licence, or several joined by AND or OR. */
type Expression = { id: string } | { all: Expression[] } | { any: Expression[] };

const CANONICAL = new Map(PERMISSIVE_LICENSES.map((id) => [id.toLowerCase(), id]));

/**
 * Reads an SPDX expression such as `(MIT OR Apache-2.0)`. Null for what is
 * not one: `SEE LICENSE IN LICENSE.txt`, `Apache 2.0`, an empty string.
 */
export function parseSpdx(source: string): Expression | null {
  const tokens = source.match(/\(|\)|[^\s()]+/g) ?? [];
  let position = 0;

  const one = (): Expression | null => {
    const token = tokens[position];
    if (token === undefined) {
      return null;
    }
    if (token === "(") {
      position++;
      const inner = any();
      if (inner === null || tokens[position] !== ")") {
        return null;
      }
      position++;
      return inner;
    }
    if (!/^[A-Za-z0-9.+-]+$/.test(token) || ["AND", "OR", "WITH"].includes(token.toUpperCase())) {
      return null;
    }
    position++;
    let id = CANONICAL.get(token.toLowerCase()) ?? token;
    // An exception changes the terms, so the licence with it is another licence than the one without.
    if (tokens[position]?.toUpperCase() === "WITH") {
      const exception = tokens[position + 1];
      if (exception === undefined || !/^[A-Za-z0-9.-]+$/.test(exception)) {
        return null;
      }
      position += 2;
      id = `${id} WITH ${exception}`;
    }
    return { id };
  };
  const all = (): Expression | null => {
    const parts: Expression[] = [];
    for (;;) {
      const part = one();
      if (part === null) {
        return null;
      }
      parts.push(part);
      if (tokens[position]?.toUpperCase() !== "AND") {
        break;
      }
      position++;
    }
    if (parts.length === 1) {
      return parts[0] ?? null;
    }
    return { all: parts };
  };
  const any = (): Expression | null => {
    const parts: Expression[] = [];
    for (;;) {
      const part = all();
      if (part === null) {
        return null;
      }
      parts.push(part);
      if (tokens[position]?.toUpperCase() !== "OR") {
        break;
      }
      position++;
    }
    if (parts.length === 1) {
      return parts[0] ?? null;
    }
    return { any: parts };
  };

  const parsed = any();
  if (parsed === null || position !== tokens.length) {
    return null;
  }
  return parsed;
}

function render(expression: Expression, nested = false): string {
  if ("id" in expression) {
    return expression.id;
  }
  let text: string;
  if ("all" in expression) {
    text = expression.all.map((part) => render(part, true)).join(" AND ");
  } else {
    text = expression.any.map((part) => render(part, true)).join(" OR ");
  }
  if (nested) {
    return `(${text})`;
  }
  return text;
}

/** Every licence an expression names. */
function idsOf(expression: Expression): string[] {
  if ("id" in expression) {
    return [expression.id];
  }
  if ("all" in expression) {
    return expression.all.flatMap(idsOf);
  }
  return expression.any.flatMap(idsOf);
}

/**
 * The ways to satisfy an expression, each a list of licences that all apply.
 * `MIT OR (ISC AND Zlib)` has two: MIT alone, or ISC together with Zlib.
 */
function choicesOf(expression: Expression): Expression[] {
  if ("id" in expression) {
    return [expression];
  }
  if ("any" in expression) {
    return expression.any.flatMap(choicesOf);
  }
  let choices: Expression[][] = [[]];
  for (const part of expression.all) {
    const next: Expression[][] = [];
    for (const taken of choices) {
      for (const choice of choicesOf(part)) {
        next.push([...taken, choice]);
      }
    }
    choices = next;
  }
  return choices.map((parts) => ({ all: parts }));
}

function isPermissive(expression: Expression): boolean {
  return idsOf(expression).every((id) => PERMISSIVE_LICENSES.includes(id));
}

/** A licence text, by a sentence only that licence has. Matched on lowercase text with single spaces. */
const TEXTS: { id: string; has: RegExp; lacks?: RegExp }[] = [
  { id: "MIT", has: /permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files/ },
  { id: "ISC", has: /permission to use, copy, modify, and(?:\/or)? distribute this software for any purpose with or without fee is hereby granted, provided that/ },
  { id: "0BSD", has: /permission to use, copy, modify, and(?:\/or)? distribute this software for any purpose with or without fee is hereby granted\./ },
  { id: "BSD-2-Clause", has: /redistribution and use in source and binary forms, with or without modification, are permitted/, lacks: /neither the name|all advertising materials/ },
  { id: "BSD-3-Clause", has: /redistribution and use in source and binary forms, with or without modification, are permitted[^]*neither the name/, lacks: /all advertising materials/ },
  { id: "BSD-4-Clause", has: /redistribution and use in source and binary forms[^]*all advertising materials/ },
  { id: "Apache-2.0", has: /apache license,? version 2\.0/ },
  { id: "Zlib", has: /altered source versions must be plainly marked as such/ },
  { id: "Unlicense", has: /this is free and unencumbered software released into the public domain/ },
  { id: "CC0-1.0", has: /cc0 1\.0 universal/ },
  { id: "BlueOak-1.0.0", has: /blue oak model license[^]*version 1\.0\.0/ },
  { id: "Python-2.0", has: /python software foundation license version 2/ },
  { id: "MPL", has: /mozilla public license/ },
  { id: "EPL", has: /eclipse public license/ },
];

/**
 * The licences a text is the text of. Usually one, none for a text this does
 * not know, several for a file that holds more than one licence. The GNU,
 * Mozilla and Eclipse licences are told by family, without their version.
 */
export function recognizeLicense(text: string): string[] {
  const plain = text
    .toLowerCase()
    .replace(/[“”"'`*#>_]/g, "")
    .replace(/\s+/g, " ");
  const found: string[] = [];
  for (const known of TEXTS) {
    if (!known.has.test(plain)) {
      continue;
    }
    if (known.lacks?.test(plain)) {
      continue;
    }
    found.push(known.id);
  }
  // Each GNU licence names the others in its text. Which one a file is shows in its title, the first of the names.
  const gnu = /gnu (affero |lesser |library )?general public license/.exec(plain);
  if (gnu !== null) {
    if (gnu[1] === undefined) {
      found.push("GPL");
    } else if (gnu[1] === "affero ") {
      found.push("AGPL");
    } else {
      found.push("LGPL");
    }
  }
  return found;
}

/** Whether a licence the package.json names is the one a text was recognized as. */
function isSame(declared: string, recognized: string): boolean {
  return declared === recognized || declared.startsWith(`${recognized}-`);
}

const COPYRIGHT_LINE = /^[\s*#/-]*((?:copyright\s+(?:\(c\)|©|\d{4})|©\s*\d{4}|\(c\)\s*\d{4}).*)$/i;

function copyrightLines(files: LicenseFile[]): string[] {
  const lines: string[] = [];
  for (const file of files) {
    for (const line of file.text.split(/\r?\n/)) {
      const found = COPYRIGHT_LINE.exec(line)?.[1]?.trim();
      // The Apache licence ends with a form to fill in, which is nobody's copyright.
      if (found === undefined || /[[{<](?:yyyy|year)[\]}>]/i.test(found) || lines.includes(found)) {
        continue;
      }
      lines.push(found);
    }
  }
  return lines;
}

/**
 * Works out what a package is licensed under.
 *
 * `declared` is the `license` of its package.json, and `own` are the files at
 * the top of the package. A licence that passes by itself needs both: the
 * package.json names it and a licence file is its text. Of `A OR B` the first
 * branch that passes this way is taken.
 */
export function readLicensing(declared: string, own: PackageFiles): Licensing {
  const texts: LicenseFile[] = [];
  const notices: LicenseFile[] = [];
  for (const name of Object.keys(own).sort()) {
    const text = own[name] ?? "";
    if (LICENSE_FILE.test(name)) {
      texts.push({ name, text });
    } else if (NOTICE_FILE.test(name)) {
      notices.push({ name, text });
    }
  }
  const licensing: Licensing = { spdx: "", review: "", texts, notices, copyright: copyrightLines([...texts, ...notices]) };

  if (declared.trim() === "") {
    licensing.review = "its package.json names no licence";
    return licensing;
  }
  const expression = parseSpdx(declared);
  if (expression === null) {
    licensing.review = `its package.json says "${declared}", which is not the name of a licence`;
    return licensing;
  }
  const permissive = choicesOf(expression).filter(isPermissive);
  if (permissive.length === 0) {
    licensing.spdx = render(expression);
    licensing.review = `${licensing.spdx} is not a licence that passes by itself`;
    return licensing;
  }
  // From here on the package.json names a licence that would pass. Its files have to show the same.
  licensing.spdx = render(permissive[0] as Expression);
  if (texts.length === 0) {
    licensing.review = `its package.json says ${declared}, and the package has no licence file to show it`;
    return licensing;
  }
  const recognized = new Set(texts.flatMap((file) => recognizeLicense(file.text)));
  const named = idsOf(expression);
  for (const id of recognized) {
    if (!named.some((declaredId) => isSame(declaredId, id))) {
      licensing.review = `its package.json says ${declared}, and its licence file is the text of ${id}`;
      return licensing;
    }
  }
  for (const choice of permissive) {
    if (idsOf(choice).every((id) => recognized.has(id))) {
      licensing.spdx = render(choice);
      return licensing;
    }
  }
  licensing.review = `its package.json says ${declared}, and its licence file is not the text of that licence`;
  return licensing;
}

/** What goes into the bundle about one package. */
export interface NoticeEntry {
  name: string;
  /** The exact version. Empty for a package from a repository that states none. */
  version: string;
  /** Where the code can be found: the release on npm, or the commit of the repository. */
  source: string;
  licensing: Licensing;
}

const NOTICES_OPEN = "/*! Third-party notices";
const NOTICES_CLOSE = "End of third-party notices */";
const RULE = "-".repeat(72);

/**
 * The block a bundle carries about the packages in it: for each its name,
 * exact version, licence, where its code is from, its copyright lines, the
 * full text of its licence and its NOTICE file.
 *
 * It is one comment at the end of the bundle. Asking the bundler to keep the
 * comments of the packages would not do: that keeps what a package happened
 * to mark with `/*!`, and most licences are in a file, not in the code.
 */
export function thirdPartyNotices(entries: NoticeEntry[]): string {
  if (entries.length === 0) {
    return "";
  }
  const lines: string[] = ["", "This detector contains code of the packages below. Each is used under its own licence."];
  for (const entry of entries) {
    lines.push("", RULE);
    let title = entry.name;
    if (entry.version !== "") {
      title = `${entry.name} ${entry.version}`;
    }
    lines.push(title);
    let license = entry.licensing.spdx;
    if (license === "") {
      license = "unknown";
    }
    if (entry.licensing.review !== "") {
      license = `${license} (${entry.licensing.review})`;
    }
    lines.push(`License: ${license}`);
    lines.push(`Source: ${entry.source}`);
    for (const line of entry.licensing.copyright) {
      lines.push(line);
    }
    for (const file of [...entry.licensing.texts, ...entry.licensing.notices]) {
      lines.push("", `${file.name}:`, "", file.text.trim());
    }
    if (entry.licensing.texts.length === 0) {
      lines.push("", "The package has no licence file.");
    }
  }
  lines.push("", RULE);
  // A licence text must not end the comment it is in.
  const body = lines.join("\n").replaceAll("*/", "* /");
  return `${NOTICES_OPEN}\n${body}\n${NOTICES_CLOSE}\n`;
}

/** The third-party notices of a bundle, as text to show. Empty when it has none. */
export function noticesOf(bundle: string): string {
  const start = bundle.lastIndexOf(NOTICES_OPEN);
  const end = bundle.lastIndexOf(NOTICES_CLOSE);
  if (start === -1 || end < start) {
    return "";
  }
  return bundle.slice(start + NOTICES_OPEN.length, end).trim();
}
