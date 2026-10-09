import { expect, test } from "vitest";
import { detect, edit, source, write } from "@wellactually/sdk/test";

// fixtures/app is a small Dart package: lib/cart/cart.dart imports the checkout, lib/shared/money.dart imports nothing.
const app = { project: "fixtures/app" };

const checkout = source`
  import 'package:app/cart/cart.dart';
  import 'package:app/shared/money.dart';

  class Checkout {}
`;

test("fires when the imported file imports this one back", () => {
  expect(detect(write("lib/checkout/checkout.dart", checkout), app)).toEqual([{ line: 1, evidence: "import 'package:app/cart/cart.dart';" }]);
});

test("fires on a relative import as well", () => {
  const code = "import '../cart/cart.dart';\n\nclass Checkout {}";
  expect(detect(write("lib/checkout/checkout.dart", code), app)).toEqual([{ line: 1, evidence: "import '../cart/cart.dart';" }]);
});

test("stays quiet on an import that leads nowhere back", () => {
  expect(detect(write("lib/checkout/checkout.dart", "import 'package:app/shared/money.dart';"), app)).toEqual([]);
});

test("stays quiet on a cycle that was already there when the agent edits another line", () => {
  expect(detect(edit("lib/checkout/checkout.dart", checkout, { written: "class Checkout {}" }), app)).toEqual([]);
});

test("stays quiet on another package and on the Dart SDK", () => {
  const code = "import 'dart:async';\nimport 'package:other/cart/cart.dart';";
  expect(detect(write("lib/checkout/checkout.dart", code), app)).toEqual([]);
});

test("stays quiet when the project has no such file", () => {
  expect(detect(write("lib/checkout/checkout.dart", checkout))).toEqual([]);
});
