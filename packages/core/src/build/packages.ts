import type { FileMap } from "./bundle.ts";
import { readLicensing, type Licensing, type NoticeEntry } from "./licenses.ts";

/**
 * Packages from npm in a principle.
 *
 * A detector may import a package by name. The package is not fetched when the
 * detector runs, and not when the registry builds it: its code travels with
 * the principle, in the same file map as `detector.ts`, below `node_modules/`.
 * Whoever submits the principle puts it there, the CLI from the packages
 * installed on disk and the website from an npm CDN. From then on the version
 * is fixed, because the code itself is part of the principle.
 *
 * The principle's own `package.json` says which packages it uses, as any
 * package.json does: an exact version or a range such as `^2.9.1`. A range is
 * settled when the principle is submitted, to the version that is installed
 * or the newest one the CDN has. The version that was taken is in the
 * manifest of the release, and it stays that until someone submits again.
 *
 * A package does not have to be on npm. `github:owner/repo`, with `#branch`,
 * `#tag` or `#commit` when it should not be the default branch, names a
 * repository, and the commit that was taken is recorded the same way.
 */

/** Where the code of packages lies in a principle's files. */
export const PACKAGE_DIR = "node_modules/";

/** One package a principle carries. */
export interface PackageInfo {
  name: string;
  version: string;
  /** As its package.json states it. Empty when it states none. */
  license: string;
  /** For a package from a repository: where it was taken from, with the commit when that is known. */
  from?: string;
  /**
   * The licence the code is taken under, as its package.json names it and its
   * licence file shows it. Of `MIT OR GPL-3.0-only` the branch that was
   * chosen. Absent when the package names no licence that can be read.
   */
  spdx?: string;
  /**
   * Why the licence does not pass by itself, in words for the expert. A
   * package that has this is only published when the expert approved it.
   */
  review?: string;
  /** The expert approved this package at this version when the principle was submitted. */
  approved?: true;
}

/**
 * How an expert names a package they approve: `name@1.2.3`, and
 * `name@github:owner/repo#commit` for one from a repository. An approval is
 * for that code and no other, so a new version has to be approved again.
 */
export function approvalKey(info: PackageInfo): string {
  if (info.from !== undefined) {
    return `${info.name}@${info.from}`;
  }
  return `${info.name}@${info.version}`;
}

/** Whether a package still waits for the expert to approve its licence. */
export function needsApproval(info: PackageInfo): boolean {
  return info.review !== undefined && info.approved !== true;
}

const GPL_LICENSE = /\b(?:AGPL|GPL)-[A-Za-z0-9.+-]+/;
const LGPL_LICENSE = /\bLGPL-[A-Za-z0-9.+-]+/;

/**
 * The licence a package puts the whole bundle under: the GPL or the AGPL, as
 * the package names it. A bundle with such a package in it is distributed
 * under the terms of that licence as a whole, not only the package. Null for
 * a package under any other licence, the LGPL included, which asks this of
 * the library alone.
 */
export function bundleTermsOf(info: PackageInfo): string | null {
  return GPL_LICENSE.exec(info.spdx ?? "")?.[0] ?? null;
}

/**
 * What approving a package means, as a sentence for the expert. For most it
 * is the reason alone. For one under a GNU licence it also says what that
 * licence asks: of the whole detector for the GPL and the AGPL, of the
 * library for the LGPL.
 */
export function describeReview(info: PackageInfo): string {
  const review = info.review ?? "its licence is not known";
  const terms = bundleTermsOf(info);
  if (terms !== null) {
    return `${review}. With it in the detector, the whole detector bundle is distributed under the terms of ${terms}`;
  }
  const library = LGPL_LICENSE.exec(info.spdx ?? "")?.[0];
  if (library !== undefined) {
    return `${review}. The part under ${library} has to stay replaceable by whoever uses the detector, and its source has to be available. The notices in the bundle link to it`;
  }
  return review;
}

/** Where the code of a package can be found by someone who reads the notices of a bundle. */
function sourceOf(info: PackageInfo): string {
  if (info.from === undefined) {
    return `https://www.npmjs.com/package/${info.name}/v/${info.version}`;
  }
  const github = parseGitHub(info.from);
  if (github === null) {
    return info.from;
  }
  if (github.ref === null) {
    return `https://github.com/${github.owner}/${github.repo}`;
  }
  return `https://github.com/${github.owner}/${github.repo}/tree/${github.ref}`;
}

/**
 * A file that travels with a package from a repository and says where its
 * code was taken from: `github:owner/repo#commit`. A source answers it like a
 * file of the package, and no package has one of its own.
 */
export const TAKEN_FROM = ".wellactually-from";

/** Reads a file of the principle by its path, or null when there is none. */
export type ReadFile = (path: string) => Promise<string | null>;

/**
 * Where the code of a package comes from while a principle is being
 * submitted: a file of the package `name`, or null when it has no such file.
 * `version` is what the principle's package.json says, an exact version or a
 * range, and null for a package that only another package depends on.
 */
export type PackageSource = (name: string, version: string | null, file: string) => Promise<string | null>;

/**
 * The packages a principle already carries from the repository it lives in,
 * and `other` for all the rest.
 *
 * A package that sits next to the principles in their repository is on no
 * registry. It came with the principle when the repository was read, marked
 * with where it was taken from, and the principle's package.json names it
 * without a repository. Such a package is served from the files that came
 * along. It is never asked for elsewhere, where a stranger could have
 * published something under the same name.
 */
export function keptPackages(files: FileMap, other: PackageSource): PackageSource {
  return async (name, version, file) => {
    const dir = `${PACKAGE_DIR}${name}/`;
    const carried = files[`${dir}${TAKEN_FROM}`] !== undefined;
    // A package the package.json asks for from a repository is read from there again, so it follows its branch.
    const asksRepository = version !== null && isGitReference(version);
    if (!carried || asksRepository) {
      return other(name, version, file);
    }
    return files[`${dir}${file}`] ?? null;
  };
}

export class PackageError extends Error {}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** A version or a range of versions from the npm registry. Not a URL, a path or a git reference. */
const VERSION_RANGE = /^[0-9A-Za-z.^~<>=|* -]+$/;

/** A repository on GitHub that a package.json names in place of a version. */
export interface GitHubReference {
  owner: string;
  repo: string;
  /** A branch, a tag or a commit. Null for the default branch. */
  ref: string | null;
}

const GITHUB_FORMS = [
  /^github:([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#([\w./-]+))?$/,
  /^([\w.-]+)\/([\w.-]+?)(?:#([\w./-]+))?$/,
  /^(?:git\+)?https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#([\w./-]+))?$/,
  /^git\+ssh:\/\/git@github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#([\w./-]+))?$/,
];

/** The repository a version in a package.json names, in any of the spellings npm takes. Null when it names none on GitHub. */
export function parseGitHub(version: string): GitHubReference | null {
  for (const form of GITHUB_FORMS) {
    const match = form.exec(version);
    if (match?.[1] && match[2]) {
      return { owner: match[1], repo: match[2], ref: match[3] ?? null };
    }
  }
  return null;
}

/** Whether a version in a package.json names a repository, on GitHub or anywhere else git reaches. */
export function isGitReference(version: string): boolean {
  return parseGitHub(version) !== null || /^git(?:\+ssh|\+https|\+http)?:\/\/[\w.@:/~+#-]+$/.test(version);
}

/** Whether a version in a package.json names one release, and not a range of them. */
export function isExactVersion(version: string): boolean {
  return EXACT_VERSION.test(version);
}
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

/** Whether a file of a principle is code of a package, and not the author's own. */
export function isPackageFile(path: string): boolean {
  return path.startsWith(PACKAGE_DIR);
}

/** The packages the principle's `package.json` names, each with the version or range it asks for. */
export function readPins(files: FileMap): Record<string, string> {
  const source = files["package.json"];
  if (source === undefined) {
    return {};
  }
  let parsed: { dependencies?: unknown };
  try {
    parsed = JSON.parse(source) as { dependencies?: unknown };
  } catch {
    throw new PackageError("package.json is not valid JSON");
  }
  const dependencies = parsed.dependencies ?? {};
  if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
    throw new PackageError('the dependencies in package.json are an object, for example: { "dependencies": { "yaml": "2.8.1" } }');
  }
  const pins: Record<string, string> = {};
  for (const [name, version] of Object.entries(dependencies)) {
    if (!PACKAGE_NAME.test(name)) {
      throw new PackageError(`"${name}" in package.json is not the name of a package`);
    }
    if (typeof version !== "string" || !(VERSION_RANGE.test(version.trim()) || isGitReference(version.trim()))) {
      throw new PackageError(`package.json has to name a version of ${name} from npm, for example "^2.9.1", or a repository, for example "github:owner/repo". It says ${JSON.stringify(version)}.`);
    }
    pins[name] = version.trim();
  }
  return pins;
}

/** `yaml/util` is the package `yaml` and the path `util` inside it. Null for what is not a package name. */
export function splitSpecifier(specifier: string): { name: string; subpath: string } | null {
  const parts = specifier.split("/");
  const count = specifier.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, count).join("/");
  if (parts.length < count || !PACKAGE_NAME.test(name)) {
    return null;
  }
  return { name, subpath: parts.slice(count).join("/") };
}

/** The package a file below `node_modules/` belongs to, or null for a file of the principle itself. */
export function packageOf(path: string): string | null {
  if (!isPackageFile(path)) {
    return null;
  }
  return splitSpecifier(path.slice(PACKAGE_DIR.length))?.name ?? null;
}

interface PackageJson {
  name?: string;
  version?: string;
  license?: unknown;
  licenses?: unknown;
  main?: unknown;
  module?: unknown;
  exports?: unknown;
}

async function readPackageJson(read: ReadFile, name: string): Promise<PackageJson | null> {
  const source = await read(`${PACKAGE_DIR}${name}/package.json`);
  if (source === null) {
    return null;
  }
  try {
    return JSON.parse(source) as PackageJson;
  } catch {
    throw new PackageError(`the package.json of ${name} is not valid JSON`);
  }
}

/**
 * The file an import of a package means, as a path in the principle's files.
 *
 * It follows what the package says about itself: its `exports`, else `module`,
 * else `main`. Of the builds a package offers, the one for a browser comes
 * first, because the isolate has no Node in it either.
 */
export async function resolvePackage(read: ReadFile, specifier: string, pins: Record<string, string>, importer: string, required: boolean): Promise<string> {
  const split = splitSpecifier(specifier);
  if (split === null) {
    throw new PackageError(`"${specifier}" is not something a detector can import`);
  }
  const { name, subpath } = split;
  const from = packageOf(importer);
  const pinned = pins[name];
  // A package may import the packages it depends on. The principle's own files may import what its package.json names.
  if (from === null && pinned === undefined) {
    throw new PackageError(`"${name}" is not in the package.json of the principle. Add it: { "dependencies": { "${name}": "^1.2.3" } }`);
  }
  const json = await readPackageJson(read, name);
  if (json === null) {
    if (from !== null) {
      throw new PackageError(`${from} imports "${name}", which is not installed`);
    }
    throw new PackageError(`"${name}" is in package.json but not installed. Run npm install in the folder of the principle.`);
  }
  if (pinned !== undefined && !satisfies(String(json.version), pinned)) {
    throw new PackageError(`package.json asks for ${name} ${pinned}, and ${String(json.version)} is installed. Run npm install.`);
  }
  const root = `${PACKAGE_DIR}${name}`;
  let target: string | null;
  if (json.exports !== undefined && json.exports !== null) {
    let key = ".";
    if (subpath !== "") {
      key = `./${subpath}`;
    }
    target = matchExports(json.exports, key, required);
    if (target === null) {
      throw new PackageError(`the package ${name} does not export "${key}"`);
    }
  } else if (subpath !== "") {
    target = subpath;
  } else if (typeof json.module === "string") {
    target = json.module;
  } else if (typeof json.main === "string") {
    target = json.main;
  } else {
    target = "index.js";
  }
  const found = await probe(read, joinPath(root, target));
  if (found === null) {
    throw new PackageError(`the package ${name} has no file for "${specifier}"`);
  }
  return found;
}

/**
 * Whether an installed version is one that `wanted` asks for.
 *
 * It knows an exact version, `^1.2.3` and `~1.2.3`, which is what npm writes.
 * For any other range the installed version is taken as the answer npm gave.
 */
function satisfies(version: string, wanted: string): boolean {
  // A repository has whatever version its package.json states, or none.
  if (isGitReference(wanted)) {
    return true;
  }
  if (isExactVersion(wanted)) {
    return version === wanted;
  }
  const range = /^([\^~])(\d+)\.(\d+)\.(\d+)$/.exec(wanted);
  const have = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (range === null || have === null) {
    return true;
  }
  const want = [Number(range[2]), Number(range[3]), Number(range[4])];
  const got = [Number(have[1]), Number(have[2]), Number(have[3])];
  // How many leading numbers have to be the same: ~ keeps major and minor, ^ keeps everything up to the first number that is not 0.
  let fixed = 2;
  if (range[1] === "^") {
    fixed = 1;
    if (want[0] === 0) {
      fixed = 2;
      if (want[1] === 0) {
        fixed = 3;
      }
    }
  }
  for (let index = 0; index < 3; index++) {
    const a = got[index] ?? 0;
    const b = want[index] ?? 0;
    if (index < fixed) {
      if (a !== b) {
        return false;
      }
      continue;
    }
    if (a !== b) {
      return a > b;
    }
  }
  return true;
}

/** A relative import inside a package, as a path in the principle's files. Null when there is no such file. */
export async function resolveInPackage(read: ReadFile, importer: string, relative: string): Promise<string | null> {
  const slash = importer.lastIndexOf("/");
  const joined = joinPath(importer.slice(0, slash), relative);
  if (!isPackageFile(joined)) {
    return null;
  }
  return probe(read, joined);
}

/** TypeScript too: a package taken from a repository has not been through a build. */
const SUFFIXES = ["", ".js", ".mjs", ".cjs", ".ts", ".json", "/index.js", "/index.mjs", "/index.cjs", "/index.ts"];

async function probe(read: ReadFile, path: string): Promise<string | null> {
  for (const suffix of SUFFIXES) {
    const candidate = `${path}${suffix}`;
    // A path without an extension may be a folder, which has no content of its own.
    if (suffix === "" && !/\.[a-z]+$/.test(candidate)) {
      continue;
    }
    if ((await read(candidate)) !== null) {
      return candidate;
    }
  }
  return null;
}

function joinPath(base: string, relative: string): string {
  const out: string[] = [];
  for (const part of `${base}/${relative}`.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

/**
 * What `exports` of a package.json gives for `key`, "." or "./sub/path".
 * Null when the package does not export it.
 */
function matchExports(exports: unknown, key: string, required: boolean): string | null {
  if (typeof exports === "string" || Array.isArray(exports)) {
    if (key !== ".") {
      return null;
    }
    return pickCondition(exports, required);
  }
  if (typeof exports !== "object" || exports === null) {
    return null;
  }
  const entries = Object.entries(exports);
  const bySubpath = entries.some(([name]) => name.startsWith("."));
  if (!bySubpath) {
    if (key !== ".") {
      return null;
    }
    return pickCondition(exports, required);
  }
  for (const [pattern, value] of entries) {
    if (pattern === key) {
      return pickCondition(value, required);
    }
    const star = pattern.indexOf("*");
    if (star === -1) {
      continue;
    }
    const before = pattern.slice(0, star);
    const after = pattern.slice(star + 1);
    if (key.length >= pattern.length - 1 && key.startsWith(before) && key.endsWith(after)) {
      const middle = key.slice(before.length, key.length - after.length);
      const picked = pickCondition(value, required);
      if (picked !== null) {
        return picked.replaceAll("*", middle);
      }
    }
  }
  return null;
}

/** The first build of a package that can run in the isolate, in the order the package lists them. */
function pickCondition(value: unknown, required: boolean): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const picked = pickCondition(item, required);
      if (picked !== null) {
        return picked;
      }
    }
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const accepted = required ? ["browser", "require", "default"] : ["browser", "import", "module", "default"];
  for (const [condition, inner] of Object.entries(value)) {
    if (!accepted.includes(condition)) {
      continue;
    }
    const picked = pickCondition(inner, required);
    if (picked !== null) {
      return picked;
    }
  }
  return null;
}

/** A package a principle carries, with what its files say about its licence. */
export interface CarriedPackage {
  info: PackageInfo;
  licensing: Licensing;
}

/**
 * The `license` of a package.json as one string. Old packages wrote
 * `{ "type": "MIT" }` or a list of those under `licenses`, and a list means
 * any of them.
 */
function declaredLicense(json: PackageJson): string {
  if (typeof json.license === "string") {
    return json.license.slice(0, 100);
  }
  const typeOf = (entry: unknown): string | null => {
    const type = (entry as { type?: unknown } | null)?.type;
    if (typeof type !== "string") {
      return null;
    }
    return type;
  };
  const single = typeOf(json.license);
  if (single !== null) {
    return single.slice(0, 100);
  }
  if (Array.isArray(json.licenses)) {
    const types: string[] = [];
    for (const entry of json.licenses) {
      const type = typeOf(entry);
      if (type !== null) {
        types.push(type);
      }
    }
    return types.join(" OR ").slice(0, 100);
  }
  return "";
}

/** Every package a principle carries, by name, with its licence. Read from the code that travels with it. */
export function carriedPackages(files: FileMap): CarriedPackage[] {
  const packages: CarriedPackage[] = [];
  for (const path of Object.keys(files).sort()) {
    const name = packageOf(path);
    if (name === null || path !== `${PACKAGE_DIR}${name}/package.json`) {
      continue;
    }
    let json: PackageJson;
    try {
      json = JSON.parse(files[path] ?? "") as PackageJson;
    } catch {
      throw new PackageError(`the package.json of ${name} is not valid JSON`);
    }
    const from = files[`${PACKAGE_DIR}${name}/${TAKEN_FROM}`]?.trim();
    let version = "";
    if (typeof json.version === "string" && EXACT_VERSION.test(json.version)) {
      version = json.version;
    }
    // Only a package from a repository may go without a version: the commit says which code it is.
    if (version === "" && from === undefined) {
      throw new PackageError(`the package.json of ${name} names no version`);
    }
    const info: PackageInfo = { name, version, license: declaredLicense(json) };
    if (from !== undefined) {
      if (!isGitReference(from) || from.length > 300) {
        throw new PackageError(`${PACKAGE_DIR}${name}/${TAKEN_FROM} does not name a repository`);
      }
      info.from = from;
    }
    // The files at the top of the package: that is where a licence lies.
    const root = `${PACKAGE_DIR}${name}/`;
    const own: FileMap = {};
    for (const [file, content] of Object.entries(files)) {
      if (file.startsWith(root) && !file.slice(root.length).includes("/")) {
        own[file.slice(root.length)] = content;
      }
    }
    const licensing = readLicensing(info.license, own);
    if (licensing.spdx !== "") {
      info.spdx = licensing.spdx;
    }
    if (licensing.review !== "") {
      info.review = licensing.review;
    }
    packages.push({ info, licensing });
  }
  return packages;
}

/** Every package a principle carries, by name. */
export function packagesOf(files: FileMap): PackageInfo[] {
  return carriedPackages(files).map((carried) => carried.info);
}

/** What the notices of a bundle say about a package. */
export function noticeOf(carried: CarriedPackage): NoticeEntry {
  return { name: carried.info.name, version: carried.info.version, source: sourceOf(carried.info), licensing: carried.licensing };
}
