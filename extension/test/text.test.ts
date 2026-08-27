import { test } from "node:test";
import assert from "node:assert/strict";
import { trunc } from "../lib/text.ts";
import { truncLine } from "../lib/brief.ts";

test("text: trunc caps length with an ellipsis", () => {
  assert.equal(trunc("short", 200), "short");
  assert.equal(trunc("x".repeat(500), 200), "x".repeat(199) + "…");
  assert.equal(trunc("abcdef", 3).length, 3);
  assert.equal(trunc("abcdef", 3), "ab…");
});

test("text: truncLine collapses whitespace first, then caps", () => {
  assert.equal(truncLine("  a\n\tb   c  "), "a b c");
  assert.equal(truncLine("x".repeat(500) + "\nmore", 200), "x".repeat(199) + "…");
});
