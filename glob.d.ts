/**
 * Glob matching for the `globs` of a file handler, on forward-slash relative paths.
 *
 * Supports `**`, `*`, `?` and `{a,b}`. A pattern without a slash matches the
 * basename anywhere, so `*.dart` and `**\/*.dart` mean the same thing.
 * A pattern that starts with `!` takes files out again: `!**\/*.g.dart`.
 */
export declare function matchesGlob(path: string, pattern: string): boolean;
/**
 * Whether `globs` select the file at `path`.
 *
 * A file is selected when one of the patterns matches it and no pattern
 * starting with `!` does. Without a pattern that selects, every file is in:
 * an empty list means all files, and `["!**\/*.g.dart"]` all but generated ones.
 */
export declare function matchesGlobs(path: string, globs: readonly string[]): boolean;
