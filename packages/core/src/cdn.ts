/**
 * The code of packages, read over the network: npm and GitHub through a CDN.
 *
 * This is where the website gets packages from, in the editor in a browser
 * and on the registry when it reads a repository. The CLI does not use it: it
 * takes what npm installed on disk.
 */
import { isExactVersion, isGitReference, parseGitHub, TAKEN_FROM, type GitHubReference, type PackageSource } from "./packages.ts";

const CDN = "https://cdn.jsdelivr.net";

/**
 * The code of packages, read from a CDN that serves npm and GitHub.
 *
 * A package is asked for at what names it: the principle's package.json, or
 * for a package that only another package depends on, the package.json of
 * that one. A range is settled to the newest release in it, and a repository
 * to the commit its branch is at. From the first file on, that exact release
 * or commit is asked for, so that all files of a package are of one state.
 */
export function cdnPackages(): PackageSource {
  /** Where the files of a package are, once that is settled. */
  const bases = new Map<string, Promise<string | null>>();
  /** What the packages read so far ask of the packages they depend on. */
  const wanted = new Map<string, string>();
  /** The repository and commit of each package that came from one. */
  const from = new Map<string, string>();

  const get = async (url: string): Promise<string | null> => {
    const response = await fetch(url);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`${url} could not be loaded: ${response.status}`);
    }
    return response.text();
  };

  const settle = async (name: string, asked: string): Promise<string | null> => {
    const github = parseGitHub(asked);
    if (github !== null) {
      const commit = await commitOf(github);
      from.set(name, `github:${github.owner}/${github.repo}#${commit}`);
      return `${CDN}/gh/${github.owner}/${github.repo}@${commit}`;
    }
    if (isGitReference(asked)) {
      throw new Error(`${name} comes from ${asked}. The editor can load a repository from GitHub only. Use the CLI for this one.`);
    }
    if (isExactVersion(asked)) {
      return `${CDN}/npm/${name}@${asked}`;
    }
    const manifest = await get(`${CDN}/npm/${name}@${encodeURIComponent(asked)}/package.json`);
    if (manifest === null) {
      return null;
    }
    return `${CDN}/npm/${name}@${String((JSON.parse(manifest) as { version?: unknown }).version)}`;
  };

  return async (name, pinned, file) => {
    let base = bases.get(name);
    if (base === undefined) {
      base = settle(name, pinned ?? wanted.get(name) ?? "latest");
      bases.set(name, base);
    }
    const root = await base;
    if (root === null) {
      return null;
    }
    if (file === TAKEN_FROM) {
      return from.get(name) ?? null;
    }
    const text = await get(`${root}/${file}`);
    if (text !== null && file === "package.json") {
      const dependencies = (JSON.parse(text) as { dependencies?: Record<string, string> }).dependencies ?? {};
      for (const [dependency, asked] of Object.entries(dependencies)) {
        if (!wanted.has(dependency)) {
          wanted.set(dependency, asked);
        }
      }
    }
    return text;
  };
}

/**
 * The commit a branch, a tag or the default branch of a repository is at.
 * When GitHub does not say, for instance because it limits how often it is
 * asked, the name itself is used, which the CDN understands as well.
 */
export async function commitOf(github: GitHubReference): Promise<string> {
  const ref = github.ref ?? "HEAD";
  try {
    const response = await fetch(`https://api.github.com/repos/${github.owner}/${github.repo}/commits/${encodeURIComponent(ref)}`, { headers: { accept: "application/vnd.github.sha" } });
    if (response.ok) {
      const commit = (await response.text()).trim();
      if (/^[0-9a-f]{40}$/.test(commit)) {
        return commit;
      }
    }
  } catch {
    // Not reachable. The name is used below.
  }
  if (github.ref === null) {
    throw new Error(`The default branch of ${github.owner}/${github.repo} could not be read from GitHub. Name a branch: github:${github.owner}/${github.repo}#main`);
  }
  return github.ref;
}
