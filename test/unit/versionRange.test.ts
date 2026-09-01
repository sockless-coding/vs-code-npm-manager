import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  isExactVersionPin,
  stripVersionPin,
  toExactVersionPin,
  toCaretRange,
  applyVersionPrefix,
  detectVersionPrefix
} from "../../src/npm/versionRange";

test("recognises exact-version pins", () => {
  assert.equal(isExactVersionPin("1.2.3"), true);
  assert.equal(isExactVersionPin("  1.2.3 "), true);
  assert.equal(isExactVersionPin("1.2.3-beta.1"), true);
  assert.equal(isExactVersionPin("^1.2.3"), false);
  assert.equal(isExactVersionPin("~1.2.3"), false);
  assert.equal(isExactVersionPin(">=1.2.3 <2.0.0"), false);
  assert.equal(isExactVersionPin("1.2.x"), false);
  assert.equal(isExactVersionPin("*"), false);
  assert.equal(isExactVersionPin(""), false);
  assert.equal(isExactVersionPin(undefined), false);
});

test("stripVersionPin extracts the base version", () => {
  assert.equal(stripVersionPin("1.2.3"), "1.2.3");
  assert.equal(stripVersionPin("^1.2.3"), "1.2.3");
  assert.equal(stripVersionPin("~1.2.3"), "1.2.3");
  assert.equal(stripVersionPin(" 1.2.3 "), "1.2.3");
  assert.equal(stripVersionPin(">=1.2.3 <2.0.0"), "1.2.3");
  assert.equal(stripVersionPin(undefined), "");
});

test("toExactVersionPin strips any range prefix", () => {
  assert.equal(toExactVersionPin("^1.2.3"), "1.2.3");
  assert.equal(toExactVersionPin("1.2.3"), "1.2.3");
});

test("toCaretRange wraps a plain version", () => {
  assert.equal(toCaretRange("1.2.3"), "^1.2.3");
  assert.equal(toCaretRange("^1.2.3"), "^1.2.3");
});

test("applyVersionPrefix writes each selector", () => {
  assert.equal(applyVersionPrefix("1.2.3", "exact"), "1.2.3");
  assert.equal(applyVersionPrefix("1.2.3", "caret"), "^1.2.3");
  assert.equal(applyVersionPrefix("1.2.3", "tilde"), "~1.2.3");
  assert.equal(applyVersionPrefix("1.2.3", "gte"), ">=1.2.3");
  assert.equal(applyVersionPrefix("^1.2.3", "tilde"), "~1.2.3");
});

test("detectVersionPrefix recognises each selector, defaulting to caret", () => {
  assert.equal(detectVersionPrefix("^1.2.3"), "caret");
  assert.equal(detectVersionPrefix("~1.2.3"), "tilde");
  assert.equal(detectVersionPrefix(">=1.2.3"), "gte");
  assert.equal(detectVersionPrefix("1.2.3"), "exact");
  assert.equal(detectVersionPrefix("1.2.x"), "caret");
  assert.equal(detectVersionPrefix("workspace:*"), "caret");
  assert.equal(detectVersionPrefix(undefined), "caret");
});
