/**
 * Input checking, written for the caller rather than for the log.
 *
 * Every caller of this server is a model that will retry, so a rejection has
 * to say which field was wrong and what would have been right. "invalid
 * input" costs a whole round trip and teaches nothing.
 */

export class InputError extends Error {}

type Json = Record<string, unknown>;

export function requireObject(input: unknown): Json {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InputError("arguments must be an object.");
  }
  return input as Json;
}

export function str(input: Json, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new InputError(
      `"${field}" is required and must be a non-empty string, got ${describe(value)}.`,
    );
  }
  return value;
}

/**
 * A required string that is allowed to be empty.
 *
 * For fields where the empty string means something rather than nothing:
 * clearing a note is a real instruction, and refusing it would leave text on
 * a finding that its author has taken back.
 */
export function text(input: Json, field: string): string {
  const value = input[field];
  if (typeof value !== "string") {
    throw new InputError(
      `"${field}" is required and must be a string, got ${describe(value)}. Pass "" to clear it.`,
    );
  }
  return value;
}

export function optionalStr(input: Json, field: string): string | undefined {
  const value = input[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new InputError(
      `"${field}" must be a string when given, got ${describe(value)}.`,
    );
  }
  return value;
}

export function positiveInt(input: Json, field: string): number {
  const value = input[field];
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 1) {
    throw new InputError(
      `"${field}" must be a whole number of 1 or more, got ${describe(value)}.`,
    );
  }
  return parsed;
}

export function oneOf<T extends string>(
  input: Json,
  field: string,
  allowed: readonly T[],
): T {
  const value = input[field];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new InputError(
      `"${field}" must be one of ${list(allowed)}, got ${describe(value)}.`,
    );
  }
  return value as T;
}

export function optionalOneOf<T extends string>(
  input: Json,
  field: string,
  allowed: readonly T[],
): T | undefined {
  const value = input[field];
  if (value === undefined || value === null || value === "") return undefined;
  return oneOf(input, field, allowed);
}

export function object(input: Json, field: string): Json {
  const value = input[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputError(
      `"${field}" is required and must be an object, got ${describe(value)}.`,
    );
  }
  return value as Json;
}

/**
 * An optional boolean, absent meaning false.
 *
 * A model asked for a boolean writes one about as often as it writes the
 * string "true", so both are accepted rather than refused on a technicality.
 */
export function flag(input: Json, field: string): boolean {
  const value = input[field];
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new InputError(
    `"${field}" must be true or false when given, got ${describe(value)}.`,
  );
}

export function optionalArray(input: Json, field: string): unknown[] {
  const value = input[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new InputError(
      `"${field}" must be an array when given, got ${describe(value)}.`,
    );
  }
  return value;
}

function list(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (typeof value === "string") return `"${value}"`;
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return String(value);
}
