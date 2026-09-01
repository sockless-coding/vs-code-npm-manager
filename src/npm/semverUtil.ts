/**
 * Thin wrapper around the `semver` package for the handful of operations the
 * manager needs: descending sort (unparseable entries last), prerelease
 * detection, and picking the highest version subject to a prerelease filter.
 */

import * as semver from "semver";

export function isPrerelease(version: string): boolean {
  const parsed = semver.parse(version, { loose: true });
  return !!parsed && parsed.prerelease.length > 0;
}

/** Newest-first; versions `semver` cannot parse sort after every valid one, input order preserved among themselves. */
export function sortVersionsDescending(versions: string[]): string[] {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const v of versions) {
    (semver.valid(v, { loose: true }) ? valid : invalid).push(v);
  }
  valid.sort((a, b) => semver.rcompare(a, b, { loose: true }));
  return [...valid, ...invalid];
}

/** Highest version, optionally excluding prereleases; `undefined` when nothing qualifies. */
export function maxVersion(versions: string[], includePrerelease: boolean): string | undefined {
  const candidates = versions.filter((v) => semver.valid(v, { loose: true }) && (includePrerelease || !isPrerelease(v)));
  if (candidates.length === 0) return undefined;
  return candidates.reduce((max, v) => (semver.gt(v, max, { loose: true }) ? v : max));
}

export { semver };
