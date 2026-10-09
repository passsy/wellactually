import type { FileMap } from "./bundle.ts";

/**
 * The files a detector may read.
 *
 * A detector asks through `node:fs`, the isolate passes the question on, and
 * one of these answers it. On a developer's machine it is the disk. In a
 * test, in the browser and on the registry it is a map of files, so a test
 * sees the same files wherever it runs. Every path is absolute, with forward
 * slashes.
 *
 * There is deliberately no boundary around a "project". Nothing reliable says
 * what the project is: a folder need not be a git repository, and one session
 * works across several. What contains a detector is what it cannot do. It
 * cannot write, it has no network and no process, and the evidence it reports
 * must be text from its event, so nothing it reads can leave.
 */
export interface ProjectFiles {
  /** The file as text. Null when it does not exist, is a directory, is not text or is too large. */
  read(path: string): string | null;
  stat(path: string): { kind: "file" | "dir"; size: number } | null;
  /** What a directory holds. Null when it is not a directory. */
  list(path: string): { name: string; kind: "file" | "dir" }[] | null;
}

/** How often one detector run may ask for a file, and how much text it may be given. */
export const MAX_FS_CALLS = 500;
export const MAX_FS_BYTES = 4 * 1024 * 1024;

/** Resolves `.` and `..` in an absolute forward-slash path. */
function normalizeAbsolute(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return `/${out.join("/")}`;
}

/**
 * A project made of a file map, rooted at `root`.
 * Used wherever there is no disk to read, and for the fixtures of a test.
 */
export function mapProject(root: string, files: FileMap): ProjectFiles {
  /** The path from `root`, or null when it is not below it: then it is nothing this project has. */
  const relative = (path: string): string | null => (path === root ? "" : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null);
  const isDir = (inside: string): boolean => inside === "" || Object.keys(files).some((name) => name.startsWith(`${inside}/`));
  return {
    read: (path) => {
      const inside = relative(path);
      return inside === null ? null : (files[inside] ?? null);
    },
    stat: (path) => {
      const inside = relative(path);
      if (inside === null) {
        return null;
      }
      const content = files[inside];
      if (content !== undefined) {
        return { kind: "file", size: new TextEncoder().encode(content).length };
      }
      return isDir(inside) ? { kind: "dir", size: 0 } : null;
    },
    list: (path) => {
      const inside = relative(path);
      if (inside === null || inside in files || !isDir(inside)) {
        return null;
      }
      const prefix = inside === "" ? "" : `${inside}/`;
      const entries = new Map<string, "file" | "dir">();
      for (const name of Object.keys(files)) {
        if (!name.startsWith(prefix)) {
          continue;
        }
        const rest = name.slice(prefix.length);
        const slash = rest.indexOf("/");
        entries.set(slash === -1 ? rest : rest.slice(0, slash), slash === -1 ? "file" : "dir");
      }
      return [...entries].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, kind]) => ({ name, kind }));
    },
  };
}

type FsAnswer =
  | { text: string }
  | { stat: { kind: "file" | "dir"; size: number } }
  | { entries: { name: string; kind: "file" | "dir" }[] }
  | { error: { code: string; message: string } };

/**
 * Answers the file questions of one detector run.
 *
 * A relative path is relative to `cwd`, which is the event's project root
 * when it has one. Without files to ask, every file is one that does not
 * exist. The run is limited in how often it may ask and how much it may read.
 */
export function fsHost(cwd: string, project: ProjectFiles | null): (request: string) => string {
  let calls = 0;
  let bytes = 0;
  const answer = (request: string): FsAnswer => {
    let op: unknown;
    let asked: unknown;
    try {
      ({ op, path: asked } = JSON.parse(request) as { op?: unknown; path?: unknown });
    } catch {
      return { error: { code: "EINVAL", message: "EINVAL: invalid argument" } };
    }
    const shown = typeof asked === "string" ? asked : "";
    const missing: FsAnswer = { error: { code: "ENOENT", message: `ENOENT: no such file or directory, '${shown}'` } };
    if (typeof asked !== "string" || project === null) {
      return missing;
    }
    if (++calls > MAX_FS_CALLS) {
      return { error: { code: "EMFILE", message: `EMFILE: a detector may ask for files at most ${MAX_FS_CALLS} times per run` } };
    }
    const path = normalizeAbsolute(asked.startsWith("/") ? asked : `${cwd}/${asked}`);
    if (op === "stat") {
      const stat = project.stat(path);
      return stat ? { stat } : missing;
    }
    if (op === "list") {
      const entries = project.list(path);
      if (entries) {
        return { entries };
      }
      return project.stat(path) === null ? missing : { error: { code: "ENOTDIR", message: `ENOTDIR: not a directory, scandir '${shown}'` } };
    }
    if (op !== "read") {
      return { error: { code: "ENOSYS", message: "ENOSYS: a detector can only read" } };
    }
    const text = project.read(path);
    if (text === null) {
      return project.stat(path)?.kind === "dir"
        ? { error: { code: "EISDIR", message: `EISDIR: illegal operation on a directory, read '${shown}'` } }
        : missing;
    }
    bytes += text.length;
    if (bytes > MAX_FS_BYTES) {
      return { error: { code: "EFBIG", message: `EFBIG: a detector may read at most ${MAX_FS_BYTES / 1024 / 1024} MB per run` } };
    }
    return { text };
  };
  return (request) => JSON.stringify(answer(request));
}
