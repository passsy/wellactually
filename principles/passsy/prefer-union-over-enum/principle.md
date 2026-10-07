---
id: prefer-union-over-enum
title: Prefer a union of literals over a TypeScript enum
summary: A TypeScript enum emits runtime code and breaks type stripping; a union of string literals gives the same safety with nothing emitted.
languages: [typescript]
events: [write]
globs: ["**/*.{ts,tsx,mts,cts}"]
---

# Prefer a union of literals over a TypeScript enum

`enum` is one of the few TypeScript features that is not just types.
It emits an object at runtime, so it cannot be erased, and Node's type stripping refuses the file.

A union of string literals is checked the same way and compiles to nothing.

```ts
// Bad
enum Status {
  Draft = "draft",
  Released = "released",
}

// Good
type Status = "draft" | "released";
```

When the values are needed at runtime, for a dropdown or a validator, derive the type from a constant list.

```ts
const STATUSES = ["draft", "released"] as const;
type Status = (typeof STATUSES)[number];
```

Declaration files that describe somebody else's enum are not yours to change.
