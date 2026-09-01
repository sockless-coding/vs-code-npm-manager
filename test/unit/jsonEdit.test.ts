import { strict as assert } from "node:assert";
import { test } from "node:test";
import { removeDependency, upsertDependency } from "../../src/projects/jsonEdit";

const pkg = `{
  "name": "demo",
  "version": "1.0.0",
  "dependencies": {
    "lodash": "^4.17.21"
  },
  "devDependencies": {
    "typescript": "^5.5.3"
  }
}
`;

test("upsertDependency updates an existing entry in place", () => {
  const updated = upsertDependency(pkg, "lodash", "^4.17.22", "dependencies");
  const doc = JSON.parse(updated);
  assert.equal(doc.dependencies.lodash, "^4.17.22");
  assert.equal(Object.keys(doc.dependencies)[0], "lodash");
});

test("upsertDependency inserts a new key alphabetically", () => {
  const updated = upsertDependency(pkg, "axios", "^1.7.0", "dependencies");
  const doc = JSON.parse(updated);
  assert.deepEqual(Object.keys(doc.dependencies), ["axios", "lodash"]);
});

test("upsertDependency creates a missing section", () => {
  const updated = upsertDependency(pkg, "react", "^18.3.1", "peerDependencies");
  const doc = JSON.parse(updated);
  assert.equal(doc.peerDependencies.react, "^18.3.1");
});

test("removeDependency deletes the key and drops an emptied section", () => {
  const onlyDep = `{
  "name": "demo",
  "dependencies": {
    "lodash": "^4.17.21"
  }
}
`;
  const updated = removeDependency(onlyDep, "lodash");
  const doc = JSON.parse(updated);
  assert.equal("dependencies" in doc, false);
});

test("removeDependency is a no-op when the package is absent", () => {
  assert.equal(removeDependency(pkg, "not-there"), pkg);
});

test("preserves indentation and trailing newline", () => {
  const tabIndented = `{\n\t"name": "demo",\n\t"dependencies": {\n\t\t"lodash": "^4.17.21"\n\t}\n}\n`;
  const updated = upsertDependency(tabIndented, "lodash", "^4.17.22", "dependencies");
  assert.ok(updated.includes('\t"dependencies": {'));
  assert.ok(updated.endsWith("\n"));
});
