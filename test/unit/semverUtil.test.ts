import { strict as assert } from "node:assert";
import { test } from "node:test";
import { versionInRange } from "../../packages/shared/src/semverUtil";

test("versionInRange matches advisory-style ranges", () => {
  // The shapes npm's advisory `vulnerable_versions` field actually uses.
  assert.equal(versionInRange("1.2.2", "<1.2.3"), true);
  assert.equal(versionInRange("1.2.3", "<1.2.3"), false);
  assert.equal(versionInRange("4.17.20", ">=4.0.0 <4.17.21"), true);
  assert.equal(versionInRange("4.17.21", ">=4.0.0 <4.17.21"), false);
  assert.equal(versionInRange("2.0.0", "<=2.0.0 || >=3.0.0 <3.1.0"), true);
  assert.equal(versionInRange("3.0.5", "<=2.0.0 || >=3.0.0 <3.1.0"), true);
  assert.equal(versionInRange("3.5.0", "<=2.0.0 || >=3.0.0 <3.1.0"), false);
});

test("versionInRange counts prereleases that fall inside the range", () => {
  assert.equal(versionInRange("1.2.3-beta.1", "<1.2.3"), true);
  assert.equal(versionInRange("2.0.0-rc.1", ">=1.0.0 <3.0.0"), true);
});

test("versionInRange treats an unparseable range as no match rather than throwing", () => {
  assert.equal(versionInRange("1.0.0", "not-a-range"), false);
  assert.equal(versionInRange("1.0.0", ""), false);
});
