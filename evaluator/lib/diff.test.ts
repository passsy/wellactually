/**
 * What counts as the agent having changed the fixture.
 *
 * This is the one piece of the harness that can fail a trial on its own. A
 * false positive here reads as "the agent edited files when it was only asked a
 * question", which is a failure in several rubrics, so the cases below are the
 * ways a fixture changes without the agent doing anything.
 *
 * `node --test` rather than vitest: the evaluator is a script with no
 * dependencies beyond types, and one test file is not worth changing that.
 */

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { diffTree } from './diff.ts';

/**
 * Builds a trial directory the way `run.ts` does — `pristine` is the tree as
 * the case built it, `workspace` is the tree after the run — and returns the
 * verdict for what `change` did to it.
 */
function afterRun(
  build: (workspace: string) => void,
  change: (workspace: string) => void,
): { edited: boolean; patch: string } {
  const runDir = mkdtempSync(join(tmpdir(), 'diff-test-'));
  const workspace = join(runDir, 'workspace');
  mkdirSync(join(workspace, 'lib'), { recursive: true });

  build(workspace);
  cpSync(workspace, join(runDir, 'pristine'), { recursive: true });
  change(workspace);

  return diffTree(runDir);
}

/** A Dart fixture, ignoring what Dart tooling generates. */
function dartPackage(workspace: string): void {
  writeFileSync(join(workspace, 'pubspec.yaml'), 'name: fleet\n');
  writeFileSync(join(workspace, '.gitignore'), '.dart_tool/\nbuild/\npubspec.lock\n');
  writeFileSync(join(workspace, 'lib', 'a.dart'), 'class A {}\n');
}

test('an untouched fixture is unedited', () => {
  const { edited } = afterRun(dartPackage, () => {});

  assert.equal(edited, false);
});

test('pub get running behind the agent is not an edit', () => {
  // Exactly the observed failure: an editor with the repository open ran
  // `pub get` against the fixture a second after it was built, and a trial
  // whose agent had only read files was failed for editing them.
  const { edited, patch } = afterRun(dartPackage, (workspace) => {
    mkdirSync(join(workspace, '.dart_tool'));
    writeFileSync(join(workspace, '.dart_tool', 'package_config.json'), '{}\n');
    writeFileSync(join(workspace, 'pubspec.lock'), 'packages: {}\n');
    mkdirSync(join(workspace, 'build'));
    writeFileSync(join(workspace, 'build', 'out.js'), 'noop\n');
  });

  assert.equal(edited, false);
  assert.equal(patch, '');
});

test('a real edit survives the junk around it', () => {
  const { edited, patch } = afterRun(dartPackage, (workspace) => {
    writeFileSync(join(workspace, 'pubspec.lock'), 'packages: {}\n');
    writeFileSync(join(workspace, 'lib', 'a.dart'), 'class A {\n  void go() {}\n}\n');
  });

  assert.equal(edited, true);
  assert.match(patch, /\+ {2}void go/);
  assert.doesNotMatch(patch, /pubspec\.lock/);
});

test('a file the agent added is an edit', () => {
  const { edited, patch } = afterRun(dartPackage, (workspace) =>
    writeFileSync(join(workspace, 'lib', 'b.dart'), 'class B {}\n'),
  );

  assert.equal(edited, true);
  assert.match(patch, /lib\/b\.dart/);
});

test('the harness own settings are not the agent', () => {
  const { edited } = afterRun(dartPackage, (workspace) => {
    mkdirSync(join(workspace, '.claude'));
    writeFileSync(join(workspace, '.claude', 'settings.json'), '{}\n');
  });

  assert.equal(edited, false);
});

test('another ecosystem ignores what that ecosystem generates', () => {
  // The reason the list is per fixture rather than one in the harness: nothing
  // here is Dart, and the harness was never told about any of it.
  const { edited } = afterRun(
    (workspace) => {
      writeFileSync(join(workspace, 'package.json'), '{"name":"fleet"}\n');
      writeFileSync(join(workspace, '.gitignore'), 'node_modules/\ndist/\n*.tsbuildinfo\n');
      writeFileSync(join(workspace, 'lib', 'a.ts'), 'export const a = 1;\n');
    },
    (workspace) => {
      mkdirSync(join(workspace, 'node_modules', 'left-pad'), { recursive: true });
      writeFileSync(join(workspace, 'node_modules', 'left-pad', 'index.js'), 'noop\n');
      mkdirSync(join(workspace, 'dist'));
      writeFileSync(join(workspace, 'dist', 'a.js'), 'noop\n');
      writeFileSync(join(workspace, 'lib.tsbuildinfo'), '{}\n');
    },
  );

  assert.equal(edited, false);
});

test('anchoring and negation are git rules, not an approximation of them', () => {
  const { edited, patch } = afterRun(
    (workspace) => {
      writeFileSync(join(workspace, '.gitignore'), '/build\n*.log\n!keep.log\n');
      writeFileSync(join(workspace, 'lib', 'a.dart'), 'class A {}\n');
    },
    (workspace) => {
      mkdirSync(join(workspace, 'build'));
      writeFileSync(join(workspace, 'build', 'out'), 'noop\n');
      // `/build` is anchored to the root, so this one is source.
      mkdirSync(join(workspace, 'lib', 'build'));
      writeFileSync(join(workspace, 'lib', 'build', 'gen.dart'), 'class G {}\n');
      writeFileSync(join(workspace, 'run.log'), 'noise\n');
      writeFileSync(join(workspace, 'keep.log'), 'kept\n');
    },
  );

  assert.equal(edited, true);
  assert.match(patch, /lib\/build\/gen\.dart/);
  assert.match(patch, /keep\.log/);
  assert.doesNotMatch(patch, /build\/out/);
  assert.doesNotMatch(patch, /run\.log/);
});

test('a filename with a space is still reported', () => {
  const { edited, patch } = afterRun(dartPackage, (workspace) =>
    writeFileSync(join(workspace, 'lib', 'my file.dart'), 'class M {}\n'),
  );

  assert.equal(edited, true);
  assert.match(patch, /my file\.dart/);
});

test('what diff can only report as Only in is still reported', () => {
  const { edited, patch } = afterRun(dartPackage, (workspace) =>
    symlinkSync('lib/a.dart', join(workspace, 'link.dart')),
  );

  assert.equal(edited, true);
  assert.match(patch, /link\.dart/);
});

test('a fixture without a .gitignore ignores nothing', () => {
  const { edited, patch } = afterRun(
    (workspace) => writeFileSync(join(workspace, 'lib', 'a.dart'), 'class A {}\n'),
    (workspace) => writeFileSync(join(workspace, 'pubspec.lock'), 'packages: {}\n'),
  );

  assert.equal(edited, true);
  assert.match(patch, /pubspec\.lock/);
});
