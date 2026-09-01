/**
 * Helpers for npm exact-version "pins".
 *
 * A dependency written as a bare version (`"1.2.3"`, no `^`/`~`/comparator) is
 * locked to precisely that version: an install will never float it forward. The
 * manager treats such a reference as "pinned": it is held back from "Update All"
 * and is not offered as the default upgrade target. Pinning never suppresses
 * vulnerability checks — a pinned package with a known advisory is still reported.
 *
 * https://docs.npmjs.com/cli/v10/configuring-npm/package-json#dependencies
 */

import * as semver from "semver";

/** True when `raw` is a bare exact version such as `1.2.3`, with no range operator. */
export function isExactVersionPin(raw: string | undefined | null): boolean {
  if (typeof raw !== "string") return false;
  const v = raw.trim();
  if (!v || !semver.valid(v)) return false;
  return !/^[\^~]|[<>=* ]|\|\|/.test(v);
}

/** The base version out of a range/pin (`^1.2.3` → `1.2.3`, `1.2.3` → `1.2.3`); best-effort for anything else. */
export function stripVersionPin(raw: string | undefined | null): string {
  if (typeof raw !== "string") return "";
  const v = raw.trim();
  if (!v) return "";
  if (semver.valid(v)) return v;
  const m = /^[\^~]?(\d[\w.\-+]*)/.exec(v);
  if (m && semver.valid(m[1])) return m[1];
  const range = semver.minVersion(v);
  return range ? range.version : v;
}

/** Wrap a plain version as an exact pin: `^1.2.3` → `1.2.3`. Idempotent; empty input is passed through. */
export function toExactVersionPin(version: string): string {
  return stripVersionPin(version) || version.trim();
}

/** Wrap a plain version as a caret range for "unpin": `1.2.3` → `^1.2.3`. */
export function toCaretRange(version: string): string {
  const base = stripVersionPin(version) || version.trim();
  return base ? `^${base}` : base;
}

/**
 * The handful of version selectors the manager exposes when installing or
 * updating a package. Anything else a user might hand-write (`1.2.x`, `>1.0.0
 * <2.0.0`, `workspace:*`, …) is left alone rather than offered as a choice.
 */
export type VersionPrefix = "exact" | "caret" | "tilde" | "gte";

export const VERSION_PREFIXES: VersionPrefix[] = ["caret", "tilde", "exact", "gte"];

export const VERSION_PREFIX_LABELS: Record<VersionPrefix, string> = {
  caret: "^ Compatible (minor + patch)",
  tilde: "~ Approximately (patch only)",
  exact: "Exact version",
  gte: ">= At least this version"
};

/** Write `version` using the given selector: `1.2.3` -> `^1.2.3` / `~1.2.3` / `1.2.3` / `>=1.2.3`. */
export function applyVersionPrefix(version: string, prefix: VersionPrefix): string {
  const base = stripVersionPin(version) || version.trim();
  if (!base) return base;
  switch (prefix) {
    case "exact":
      return base;
    case "caret":
      return `^${base}`;
    case "tilde":
      return `~${base}`;
    case "gte":
      return `>=${base}`;
  }
}

/** Best-effort selector a currently-written range was created with; defaults to "caret" for anything unrecognized. */
export function detectVersionPrefix(raw: string | undefined | null): VersionPrefix {
  if (typeof raw !== "string") return "caret";
  const v = raw.trim();
  if (v.startsWith("^")) return "caret";
  if (v.startsWith("~")) return "tilde";
  if (v.startsWith(">=")) return "gte";
  if (isExactVersionPin(v)) return "exact";
  return "caret";
}

/** Not a resolvable semver range at all — `workspace:*`, `file:../x`, `git+https://...`, `latest`, etc. */
export function isUnresolvableRange(raw: string | undefined | null): boolean {
  if (typeof raw !== "string") return true;
  const v = raw.trim();
  if (!v) return true;
  if (semver.validRange(v)) return false;
  return true;
}
