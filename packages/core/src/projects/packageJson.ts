/**
 * Reading `package.json`. We only need a shallow view: the four dependency
 * sections and an optional `workspaces` field. Writing is done by `jsonEdit.ts`
 * so formatting (indentation, key order) is preserved.
 */

import { DependencyType } from "@npm-manager/shared";

export interface PackageDependencyRef {
  id: string;
  /** Range/version as written (e.g. `^1.2.3`, `1.2.3`, `workspace:*`). */
  version: string;
  dependencyType: DependencyType;
}

export interface ParsedPackageJson {
  name?: string;
  version?: string;
  dependencies: PackageDependencyRef[];
  /** Glob patterns for member packages, when this file is a workspace root. */
  workspaces?: string[];
}

const DEPENDENCY_FIELDS: DependencyType[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies"
];

export function parsePackageJson(text: string): ParsedPackageJson {
  const result: ParsedPackageJson = { dependencies: [] };
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    return result;
  }
  if (!doc || typeof doc !== "object") return result;

  result.name = typeof doc.name === "string" ? doc.name : undefined;
  result.version = typeof doc.version === "string" ? doc.version : undefined;

  for (const field of DEPENDENCY_FIELDS) {
    const section = doc[field];
    if (!section || typeof section !== "object") continue;
    for (const [id, version] of Object.entries(section)) {
      if (typeof version === "string") {
        result.dependencies.push({ id, version, dependencyType: field });
      }
    }
  }

  if (Array.isArray(doc.workspaces)) {
    result.workspaces = doc.workspaces.filter((w: unknown) => typeof w === "string");
  } else if (doc.workspaces && Array.isArray(doc.workspaces.packages)) {
    result.workspaces = doc.workspaces.packages.filter((w: unknown) => typeof w === "string");
  }

  return result;
}
