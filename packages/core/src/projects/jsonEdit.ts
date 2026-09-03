/**
 * Format-preserving-ish edits to `package.json`.
 *
 * Unlike MSBuild XML, JSON carries no comments and no semantically-meaningful
 * whitespace, so a full parse/mutate/re-serialize round trip is safe. We only
 * need to detect and reapply the file's indentation, line-ending style and
 * trailing newline so a one-dependency change doesn't produce a whole-file diff.
 * New dependency keys are inserted in alphabetical order within their section,
 * matching what `npm install` itself does.
 */

import { DependencyType } from "@npm-manager/shared";

const DEPENDENCY_FIELDS: DependencyType[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies"
];

interface FileFormat {
  indent: string;
  trailingNewline: boolean;
  crlf: boolean;
}

function detectFormat(text: string): FileFormat {
  const crlf = /\r\n/.test(text) && text.split("\r\n").length >= text.split("\n").length;
  const indentMatch = /\n([ \t]+)\S/.exec(text);
  return {
    indent: indentMatch ? indentMatch[1] : "  ",
    trailingNewline: /\r?\n\s*$/.test(text),
    crlf
  };
}

function serialize(doc: unknown, format: FileFormat): string {
  let out = JSON.stringify(doc, null, format.indent);
  if (format.trailingNewline) out += "\n";
  if (format.crlf) out = out.replace(/\n/g, "\r\n");
  return out;
}

function sortedSection(section: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(section).sort((a, b) => a.localeCompare(b))) {
    sorted[key] = section[key];
  }
  return sorted;
}

/** Add or update a dependency in `dependencyType`; the section is created if missing. */
export function upsertDependency(text: string, id: string, version: string, dependencyType: DependencyType): string {
  const format = detectFormat(text);
  const doc = JSON.parse(text);
  const section = { ...(doc[dependencyType] && typeof doc[dependencyType] === "object" ? doc[dependencyType] : {}) };
  section[id] = version;
  doc[dependencyType] = sortedSection(section);
  return serialize(doc, format);
}

/** Remove a dependency from whichever section(s) reference it. No-op (returns `text` unchanged) if absent. */
export function removeDependency(text: string, id: string): string {
  const format = detectFormat(text);
  const doc = JSON.parse(text);
  let changed = false;
  for (const field of DEPENDENCY_FIELDS) {
    const section = doc[field];
    if (section && typeof section === "object" && Object.prototype.hasOwnProperty.call(section, id)) {
      delete section[id];
      if (Object.keys(section).length === 0) delete doc[field];
      changed = true;
    }
  }
  if (!changed) return text;
  return serialize(doc, format);
}
