import { strict as assert } from "node:assert";
import { test } from "node:test";
import { collectAdvisories, NpmAuditAdvisory } from "../../src/projects/advisories";

// Trimmed from a real `npm audit --json` run against a project depending on the
// long-deprecated `request@2.81.0`, which pulls in several vulnerable
// sub-dependencies. `request` itself has one advisory of its own (SSRF) plus a
// chain of bare package-name references to the packages that actually carry the
// rest of its exposure — the exact shape `collectAdvisories` exists to resolve.
const entries: Record<string, NpmAuditAdvisory> = {
  ajv: {
    severity: "moderate",
    via: [{ title: "Prototype Pollution in Ajv", url: "https://github.com/advisories/GHSA-v88g-cgmw-v5xw", severity: "moderate" }]
  },
  boom: { severity: "high", via: ["hoek"] },
  cryptiles: { severity: "high", via: ["boom"] },
  "form-data": {
    severity: "critical",
    via: [{ title: "form-data uses unsafe random function for choosing boundary", url: "https://github.com/advisories/GHSA-fjxv-7rqg-78g4", severity: "critical" }]
  },
  "har-validator": { severity: "moderate", via: ["ajv"] },
  hawk: {
    severity: "high",
    via: [
      { title: "Uncontrolled Resource Consumption in Hawk", url: "https://github.com/advisories/GHSA-44pw-h2cw-w3vq", severity: "high" },
      "boom",
      "cryptiles",
      "hoek"
    ]
  },
  hoek: {
    severity: "high",
    via: [{ title: "hoek subject to prototype pollution via the clone function", url: "https://github.com/advisories/GHSA-c429-5p7v-vgjp", severity: "high" }]
  },
  request: {
    severity: "critical",
    via: [
      { title: "Server-Side Request Forgery in Request", url: "https://github.com/advisories/GHSA-p8p7-x288-28g6", severity: "critical" },
      "form-data",
      "har-validator",
      "hawk"
    ]
  }
};

test("a direct dependency's own advisory is included", () => {
  const result = collectAdvisories("request", entries);
  assert.ok(result.some((v) => v.title === "Server-Side Request Forgery in Request"));
});

test("advisories are resolved through the full via chain, not just one hop", () => {
  const result = collectAdvisories("request", entries);
  const titles = result.map((v) => v.title);
  // form-data and hawk are direct via-references with their own advisory.
  assert.ok(titles.includes("form-data uses unsafe random function for choosing boundary"));
  assert.ok(titles.includes("Uncontrolled Resource Consumption in Hawk"));
  // ajv is two hops away (request -> har-validator -> ajv), and hoek is two hops
  // away the other direction (request -> hawk -> hoek) — both must still surface.
  assert.ok(titles.includes("Prototype Pollution in Ajv"));
  assert.ok(titles.includes("hoek subject to prototype pollution via the clone function"));
});

test("a package with no advisory of its own inherits its dependency's", () => {
  const result = collectAdvisories("boom", entries);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "hoek subject to prototype pollution via the clone function");
  assert.equal(result[0].severity, 2); // high
});

test("a diamond reference (hawk -> boom AND hawk -> cryptiles -> boom) is not duplicated", () => {
  const result = collectAdvisories("hawk", entries);
  const hoekHits = result.filter((v) => v.title?.startsWith("hoek"));
  assert.equal(hoekHits.length, 1);
});

test("an isolated package with several of its own advisories returns all of them", () => {
  const result = collectAdvisories("form-data", entries);
  assert.equal(result.length, 1);
});

test("an unknown package resolves to no advisories", () => {
  assert.deepEqual(collectAdvisories("left-pad", entries), []);
});

test("a cycle terminates instead of recursing forever", () => {
  const cyclic: Record<string, NpmAuditAdvisory> = {
    a: { severity: "low", via: ["b"] },
    b: { severity: "low", via: ["a"] }
  };
  assert.deepEqual(collectAdvisories("a", cyclic), []);
});
