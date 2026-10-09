# @wellactually/sdk

What a [Well Actually](https://github.com/passsy/wellactually) principle's detector imports, and what its tests import to run under vitest.

This branch is generated.
The source is in `packages/sdk` on the `main` branch.
It exists because the SDK is not on npm yet: npm installs the root of a repository, and this is the SDK built, at a root.

## Use it in a repository of principles

```bash
npm install --save-dev github:passsy/wellactually#sdk vitest
```

```json
{
  "type": "module",
  "scripts": { "test": "vitest run" }
}
```

```text
rules/
  avoid-late/
    principle.md
    detector.ts
    detector.test.ts
```

```bash
npm test
```

```bash
npx vitest run rules/avoid-late
```

A test builds the principle it is in and runs its real detector in the real sandbox.

```ts
import { expect, test } from "vitest";
import { detect, write } from "@wellactually/sdk/test";

test("fires on a late field", () => {
  expect(detect(write("lib/user.dart", "late String name;"))).toEqual([{ line: 1, evidence: "late String name;" }]);
});
```

## Versions

This is version 0.7.2.
The lockfile of your repository pins the commit it installed.
`npm update @wellactually/sdk` moves to the newest.
The API is still changing.
A detector says which detector API version it was written against with `export const api = 2;`, and keeps running against that version.
