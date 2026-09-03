/**
 * Package-age helpers for the supply-chain guardrail. Kept in their own module
 * (no DOM / React) so they can be unit-tested directly.
 */

import type { VersionInfo } from "@npm-manager/shared";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole/fractional days since `iso`; `Infinity` when missing or unparseable. */
export function ageInDays(iso: string | undefined, now: number = Date.now()): number {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity;
  return Math.max(0, (now - t) / DAY_MS);
}

/** "just now" / "3 days ago" / "2 months ago"; "" when the date is unknown. */
export function formatRelativeAge(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const days = Math.floor((now - t) / DAY_MS);
  if (days <= 0) {
    const hours = Math.floor((now - t) / (60 * 60 * 1000));
    if (hours <= 0) return "just now";
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/**
 * Pick the version to preselect: the newest one (respecting the prerelease
 * filter) that is at least `minAgeDays` old. Falls back to the newest available
 * version when every candidate is too new or no publish dates are known.
 * `versions` is assumed newest-first (as produced by the metadata service).
 */
export function pickDefaultVersion(
  versions: VersionInfo[],
  includePrerelease: boolean,
  minAgeDays: number,
  now: number = Date.now()
): string {
  const candidates = versions.filter((v) => includePrerelease || !v.isPrerelease);
  const pool = candidates.length > 0 ? candidates : versions;
  if (pool.length === 0) return "";
  if (minAgeDays > 0) {
    const oldEnough = pool.find((v) => ageInDays(v.published, now) >= minAgeDays);
    if (oldEnough) return oldEnough.version;
  }
  return pool[0].version;
}
