import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ageInDays, formatRelativeAge, pickDefaultVersion } from "../../src/webview/packageAge";
import type { VersionInfo } from "../../src/panel/messaging";

const NOW = Date.parse("2026-08-30T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

test("ageInDays returns Infinity for missing / unparseable dates", () => {
  assert.equal(ageInDays(undefined, NOW), Infinity);
  assert.equal(ageInDays("not-a-date", NOW), Infinity);
});

test("ageInDays measures elapsed days", () => {
  assert.equal(Math.round(ageInDays(daysAgo(10), NOW)), 10);
});

test("formatRelativeAge produces human strings", () => {
  assert.equal(formatRelativeAge(daysAgo(0), NOW), "just now");
  assert.equal(formatRelativeAge(daysAgo(1), NOW), "1 day ago");
  assert.equal(formatRelativeAge(daysAgo(3), NOW), "3 days ago");
  assert.equal(formatRelativeAge(daysAgo(60), NOW), "2 months ago");
  assert.equal(formatRelativeAge(undefined, NOW), "");
});

const versions = (specs: [string, number, boolean?][]): VersionInfo[] =>
  specs.map(([version, age, pre]) => ({
    version,
    isPrerelease: !!pre,
    published: daysAgo(age)
  }));

test("pickDefaultVersion holds back versions newer than the minimum age", () => {
  const v = versions([
    ["13.0.4", 2],
    ["13.0.3", 40],
    ["13.0.1", 400]
  ]);
  assert.equal(pickDefaultVersion(v, false, 7, NOW), "13.0.3");
});

test("pickDefaultVersion falls back to newest when all are too new", () => {
  const v = versions([
    ["2.0.0", 1],
    ["1.9.0", 3]
  ]);
  assert.equal(pickDefaultVersion(v, false, 7, NOW), "2.0.0");
});

test("pickDefaultVersion returns newest when the check is disabled", () => {
  const v = versions([
    ["2.0.0", 1],
    ["1.9.0", 300]
  ]);
  assert.equal(pickDefaultVersion(v, false, 0, NOW), "2.0.0");
});

test("pickDefaultVersion respects the prerelease filter", () => {
  const v = versions([
    ["2.0.0-beta", 90, true],
    ["1.9.0", 90]
  ]);
  assert.equal(pickDefaultVersion(v, false, 7, NOW), "1.9.0");
  assert.equal(pickDefaultVersion(v, true, 7, NOW), "2.0.0-beta");
});
