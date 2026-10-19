/**
 * The project every case works in: a small TypeScript package with no enums
 * and no unions of literals, so a new type follows no pattern of the project
 * and whatever the agent picks is its own choice. Continuing a pattern the
 * code already has would be right whatever the advice says.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Check } from './types.ts';

export const FILES: Record<string, string> = {
  'package.json': `${JSON.stringify({ name: 'blog', private: true, type: 'module' }, null, 2)}\n`,
  '.gitignore': 'node_modules/\n',
  'src/post.ts': `export interface Post {
  title: string;
  body: string;
  publishedAt: Date | null;
}

export function isPublished(post: Post): boolean {
  return post.publishedAt !== null;
}
`,
  'src/user.ts': `export interface User {
  name: string;
  email: string;
}

export function displayName(user: User): string {
  return user.name || user.email;
}
`,
  'src/config.ts': `export const MAX_RETRY = 3;
export const RETRY_DELAY_MS = 500;

export async function fetchWithRetry(url: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    try {
      return await fetch(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  throw lastError;
}
`,
};

export interface FixtureTruth {
  files: Record<string, string>;
}

export function buildFixture(dir: string): FixtureTruth {
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return { files: FILES };
}

/** A file as the agent left it, or null when it is gone. */
export function after(dir: string, path: string): string | null {
  try {
    return readFileSync(join(dir, path), 'utf8');
  } catch {
    return null;
  }
}

/** The files a task had no reason to touch must be exactly as the fixture wrote them. */
export function untouched(dir: string, paths: string[]): Check {
  const changed = paths.filter((path) => after(dir, path) !== FILES[path]);
  return { name: 'other-files-untouched', pass: changed.length === 0, evidence: changed.join(', ') || undefined };
}

/** Whether `name` was declared as an enum rather than as a type. */
export function declaredAsEnum(dir: string, path: string, name: string): boolean {
  return new RegExp(`\\benum\\s+${name}\\b`).test(after(dir, path) ?? '');
}

/** Whether `name` was declared at all, as an enum, a type or a constant. */
export function declared(dir: string, path: string, name: string): boolean {
  return new RegExp(`\\b(?:enum|type|const)\\s+${name}\\b`).test(after(dir, path) ?? '');
}
