/**
 * What the agent did to the fixture.
 *
 * Kept apart from the run loop because deciding what counts as a change is not
 * bookkeeping: a trial can be failed by a file the agent never touched. An
 * editor with the repository open ran `pub get` against a fixture one second
 * after it was built, and the resulting `pubspec.lock` failed a trial whose
 * agent had only ever read files.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Hidden entries, at any depth, are never the agent's answer, and this is the
 * harness's call rather than a fixture's: `.claude` and `.codex` are settings
 * the harness wrote, `.git` is history a text diff cannot read anyway, and the
 * `.gitignore` that decides everything else is itself hidden. Nothing a case
 * builds or grades is a dotfile.
 *
 * `diff` matches the pattern against each basename it is about to descend
 * into, so the one pattern covers the whole tree.
 */
const HIDDEN = '.*';

/**
 * What the agent did to the fixture, ignoring hidden and ignored files.
 *
 * The comparison had to happen anyway to tell the judge whether anything was
 * edited, so it may as well keep the patch: "the tree changed" answers far less
 * than "here is the line it added".
 *
 * Run from inside the trial directory so the headers read `pristine/lib/x.dart`
 * against `workspace/lib/x.dart` rather than two absolute paths.
 */
export function diffTree(runDir: string): { edited: boolean; patch: string } {
  const { status, stdout, error } = spawnSync(
    'diff',
    ['-ruN', `--exclude=${HIDDEN}`, 'pristine', 'workspace'],
    { cwd: runDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );

  // 0 identical, 1 differences, anything else is diff itself failing. Reporting
  // "nothing changed" in that last case would hand the judge a false fact, and
  // a case that grades an edit would fail for a reason that is not the agent's.
  if (error || status === null || status > 1) {
    const why = error ? String(error) : `diff exited ${status}`;
    return { edited: true, patch: `Could not diff the fixture: ${why}` };
  }

  const sections = splitPatch(stdout);
  const ignored = ignoredPaths(
    join(runDir, 'workspace'),
    sections.map((section) => section.path),
  );
  const kept = sections.filter((section) => !ignored.has(section.path));

  return { edited: kept.length > 0, patch: kept.map((section) => section.text).join('') };
}

/** One file's worth of a `diff -ruN` patch, and the fixture path it is about. */
interface PatchSection {
  path: string;
  text: string;
}

/**
 * Splits a recursive patch per file, so ignored files can be dropped from the
 * patch and not only from the verdict.
 *
 * `-N` turns a file that exists on one side only into an ordinary section, so
 * `diff -ruN …` headers carry the whole patch. `Only in` survives for what has
 * no diff to show — a symlink, a socket, a directory facing a file — and is
 * kept as its own section so nothing is silently dropped.
 *
 * Both patterns are anchored at the start of the line, which is what makes this
 * safe against a fixture that contains a patch: every line of a file's contents
 * arrives prefixed by a space, a `+` or a `-`, so nothing inside a hunk can be
 * mistaken for a header. Paths are read to the end of the line rather than to
 * the next space, because a fixture may contain a filename with a space in it.
 */
function splitPatch(patch: string): PatchSection[] {
  const sections: PatchSection[] = [];

  for (const line of patch.split('\n')) {
    const header = /^diff .* workspace\/(.+)$/.exec(line);
    const only = /^Only in (?:pristine|workspace)(?:\/(.+?))?: (.+)$/.exec(line);

    if (header?.[1]) {
      sections.push({ path: header[1], text: `${line}\n` });
      continue;
    }
    if (only?.[2]) {
      const path = only[1] ? `${only[1]}/${only[2]}` : only[2];
      sections.push({ path, text: `${line}\n` });
      continue;
    }

    const current = sections.at(-1);
    if (current && line) {
      current.text += `${line}\n`;
    }
  }

  return sections;
}

/**
 * Which of these paths the fixture's own `.gitignore` files ignore.
 *
 * git is the only thing that reads a `.gitignore` correctly — anchoring,
 * negation, `**`, directory-only patterns — and reimplementing a subset here
 * would quietly disagree with the file it claims to honour. The repository it
 * needs is a throwaway outside the fixture, so this never puts a `.git` in a
 * tree an agent is about to be graded on, and it runs after the agent is done
 * either way.
 *
 * A fixture without a `.gitignore` ignores nothing, which is the same answer
 * git gives.
 */
function ignoredPaths(workspace: string, paths: string[]): Set<string> {
  if (paths.length === 0) {
    return new Set();
  }

  const scratch = mkdtempSync(join(tmpdir(), 'rules-eval-ignore-'));
  const gitDir = join(scratch, 'ignore.git');
  try {
    if (spawnSync('git', ['init', '-q', '--bare', gitDir], { encoding: 'utf8' }).status !== 0) {
      return new Set();
    }

    // --no-index because nothing is tracked in a repository this empty, and -z
    // because a fixture is free to contain a path with a space in it. Exit 1 is
    // git for "none of them", not for a failure.
    const found = spawnSync(
      'git',
      ['--git-dir', gitDir, '--work-tree', workspace, 'check-ignore', '--no-index', '-z', '--stdin'],
      { cwd: workspace, encoding: 'utf8', input: `${paths.join('\0')}\0` },
    );
    if (found.status !== 0 && found.status !== 1) {
      return new Set();
    }

    return new Set(found.stdout.split('\0').filter(Boolean));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
