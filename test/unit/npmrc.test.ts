import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseNpmrc, mergeNpmrc, findAuthPrefix } from "../../packages/core/src/npm/npmrc";

test("parses the default registry and scoped registries", () => {
  const p = parseNpmrc(`
registry=https://registry.npmjs.org/
@myco:registry=https://npm.myco.dev/
`);
  assert.equal(p.registry, "https://registry.npmjs.org/");
  assert.equal(p.scopedRegistries.get("myco"), "https://npm.myco.dev/");
});

test("parses host-scoped auth entries", () => {
  const p = parseNpmrc(`//npm.myco.dev/:_authToken=abc123\n//legacy.myco.dev/:_auth=dXNlcjpwYXNz\n`);
  assert.equal(p.authTokens.get("npm.myco.dev/"), "abc123");
  assert.equal(p.basicAuth.get("legacy.myco.dev/"), "dXNlcjpwYXNz");
});

test("ignores comments and blank lines", () => {
  const p = parseNpmrc("# a comment\n; also a comment\n\nregistry=https://registry.npmjs.org/\n");
  assert.equal(p.registry, "https://registry.npmjs.org/");
});

test("merge: nearest (later) config wins on conflicts", () => {
  const merged = mergeNpmrc([
    parseNpmrc("registry=https://global/\n"),
    parseNpmrc("registry=https://project/\n@myco:registry=https://npm.myco.dev/\n")
  ]);
  assert.equal(merged.registry, "https://project/");
  assert.equal(merged.scopedRegistries.get("myco"), "https://npm.myco.dev/");
});

test("findAuthPrefix matches by host/path prefix", () => {
  const map = new Map([["npm.myco.dev/packages", "token"]]);
  assert.equal(findAuthPrefix(map, "https://npm.myco.dev/packages/some-lib"), "npm.myco.dev/packages");
  assert.equal(findAuthPrefix(map, "https://other.dev/packages/some-lib"), undefined);
});
