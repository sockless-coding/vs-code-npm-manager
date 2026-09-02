/**
 * Resolving `npm audit --json` advisory chains.
 *
 * `npm audit` attaches the actual advisory object (title, url, severity, the
 * vulnerable range) only to the package that carries the CVE. Every package that
 * merely *depends* on it — however many hops up — is listed with a bare package
 * name in its own `via` array instead of a copy of the advisory. A direct
 * dependency can therefore end up with an empty or misleadingly short advisory
 * list of its own even though it is genuinely exposed through, say, a bundled
 * sub-dependency three levels down. `collectAdvisories` walks those `via` chains
 * recursively so every affected package — direct or transitive — ends up with
 * the full, real set of advisories that apply to it.
 *
 * No VS Code dependency, so this is unit-testable directly.
 */

import { VulnerabilityInfo } from "@npm-manager/shared";

/**
 * One `via` entry is either a plain package name — this package is only affected
 * because it depends on that (also-listed) package — or an actual advisory object.
 */
export type NpmAuditVia = string | { title?: string; url?: string; severity?: string; range?: string; cwe?: string[] };

export interface NpmAuditAdvisory {
  severity: "info" | "low" | "moderate" | "high" | "critical";
  via: NpmAuditVia[];
  range?: string;
  nodes?: string[];
  /** Other packages that become vulnerable because they depend on this one. */
  effects?: string[];
}

export interface NpmAuditOutput {
  vulnerabilities?: Record<string, NpmAuditAdvisory>;
}

export const SEVERITY_WORDS: Record<string, number> = { info: 0, low: 0, moderate: 1, high: 2, critical: 3 };

/** Resolve every real advisory reachable from `name`'s `via` chain. Cycle-guarded via `seen`. */
export function collectAdvisories(
  name: string,
  entries: Record<string, NpmAuditAdvisory>,
  seen: Set<string> = new Set()
): VulnerabilityInfo[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const entry = entries[name];
  if (!entry) return [];

  const results: VulnerabilityInfo[] = [];
  for (const v of entry.via) {
    if (typeof v === "string") {
      results.push(...collectAdvisories(v, entries, seen));
    } else if (v.url) {
      results.push({
        severity: SEVERITY_WORDS[v.severity ?? entry.severity] ?? 0,
        advisoryUrl: v.url,
        title: v.title,
        range: v.range
      });
    }
  }
  return results;
}
