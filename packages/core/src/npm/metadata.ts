/**
 * Package documents ("packuments") from the npm registry. A single GET returns
 * every version's manifest, publish dates and the readme, so — unlike NuGet's
 * split flat-container / registration resources — one request covers the whole
 * detail view.
 *
 * https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md#getpackageversion
 */

import { HttpClient } from "./httpClient";
import { sortVersionsDescending, isPrerelease, versionInRange, SEVERITY_RANK } from "@npm-manager/shared";
import { PackageDependencyGroup, PackageDetail, VersionInfo, VulnerabilityInfo } from "@npm-manager/shared";

export interface VersionManifest {
  name: string;
  version: string;
  description?: string;
  author?: { name?: string } | string;
  license?: string | { type?: string };
  homepage?: string;
  repository?: { url?: string } | string;
  keywords?: string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  deprecated?: string;
  maintainers?: { name: string }[];
}

export interface Packument {
  name: string;
  "dist-tags"?: Record<string, string>;
  versions: Record<string, VersionManifest>;
  time?: Record<string, string>;
  readme?: string;
  license?: string | { type?: string };
  homepage?: string;
}

const DOC_TTL = 5 * 60 * 1000;
const ADVISORY_TTL = 30 * 60 * 1000;

/** One entry from the registry's bulk advisory endpoint (`/-/npm/v1/security/advisories/bulk`). */
interface BulkAdvisory {
  id?: number;
  url?: string;
  title?: string;
  severity?: string;
  vulnerable_versions?: string;
}

export class MetadataService {
  constructor(private readonly http: HttpClient) {}

  async getDocument(registryUrl: string, packageId: string, signal?: AbortSignal): Promise<Packument> {
    const url = new URL(packageUrlSegment(packageId), registryUrl).toString();
    return this.http.getJson<Packument>(url, { ttlMs: DOC_TTL, signal });
  }

  /** All published versions, newest-first. */
  async listVersions(registryUrl: string, packageId: string, signal?: AbortSignal): Promise<string[]> {
    try {
      const doc = await this.getDocument(registryUrl, packageId, signal);
      return sortVersionsDescending(Object.keys(doc.versions ?? {}));
    } catch {
      return [];
    }
  }

  /** Map of version -> publish date (ISO), from the packument's `time` field. */
  async publishedDates(registryUrl: string, packageId: string, signal?: AbortSignal): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      const doc = await this.getDocument(registryUrl, packageId, signal);
      for (const [version, date] of Object.entries(doc.time ?? {})) {
        if (version === "created" || version === "modified") continue;
        map.set(version, date);
      }
    } catch {
      /* ignore */
    }
    return map;
  }

  async getPackageDetail(
    registryUrl: string,
    registryName: string,
    packageId: string,
    includePrerelease: boolean,
    signal?: AbortSignal
  ): Promise<PackageDetail> {
    const doc = await this.getDocument(registryUrl, packageId, signal);
    const allVersions = sortVersionsDescending(Object.keys(doc.versions ?? {}));

    const versions: VersionInfo[] = allVersions.map((v) => ({
      version: v,
      isPrerelease: isPrerelease(v),
      published: doc.time?.[v],
      deprecated: typeof doc.versions?.[v]?.deprecated === "string" ? doc.versions[v].deprecated : undefined
    }));

    await this.foldAdvisories(registryUrl, doc.name ?? packageId, versions, signal);

    const latestTag = doc["dist-tags"]?.latest;
    const selectable = versions.filter((v) => includePrerelease || !v.isPrerelease);
    const selectedVersion =
      (latestTag && selectable.some((v) => v.version === latestTag) ? latestTag : selectable[0]?.version) ??
      versions[0]?.version ??
      "";
    const manifest = doc.versions?.[selectedVersion];

    return {
      id: doc.name ?? packageId,
      versions,
      selectedVersion,
      description: manifest?.description ?? "",
      authors: normalizeAuthors(manifest),
      projectUrl: manifest?.homepage || doc.homepage || repositoryUrl(manifest?.repository),
      licenseExpression: licenseString(manifest?.license ?? doc.license),
      tags: manifest?.keywords ?? [],
      dependencyGroups: mapDependencyGroups(manifest),
      deprecation: manifest?.deprecated ? { reasons: [manifest.deprecated], message: manifest.deprecated } : undefined,
      readmeMarkdown: trimReadme(doc.readme),
      source: registryName
    };
  }

  /**
   * Ask the registry's bulk advisory endpoint which of `versions` are affected by
   * a known advisory and attach the matches to each {@link VersionInfo}. This is
   * the same endpoint `npm audit` uses; the response lists advisories with a
   * `vulnerable_versions` range, so the per-version match is a local semver check.
   *
   * Best-effort: private or proxying registries frequently do not implement the
   * endpoint (404 / non-JSON), in which case versions are simply left unmarked.
   */
  private async foldAdvisories(
    registryUrl: string,
    packageId: string,
    versions: VersionInfo[],
    signal?: AbortSignal
  ): Promise<void> {
    if (versions.length === 0) return;
    let advisories: BulkAdvisory[];
    try {
      const url = new URL("-/npm/v1/security/advisories/bulk", ensureTrailingSlash(registryUrl)).toString();
      const body = { [packageId]: versions.map((v) => v.version) };
      const res = await this.http.postJson<Record<string, BulkAdvisory[]>>(url, body, {
        ttlMs: ADVISORY_TTL,
        signal
      });
      advisories = res?.[packageId] ?? [];
    } catch {
      return;
    }
    if (advisories.length === 0) return;

    for (const v of versions) {
      const hits = new Map<string, VulnerabilityInfo>();
      for (const a of advisories) {
        if (!a.vulnerable_versions || !a.url) continue;
        if (hits.has(a.url)) continue;
        if (!versionInRange(v.version, a.vulnerable_versions)) continue;
        hits.set(a.url, {
          severity: SEVERITY_RANK[a.severity ?? ""] ?? 0,
          advisoryUrl: a.url,
          title: a.title,
          range: a.vulnerable_versions
        });
      }
      if (hits.size > 0) {
        v.vulnerabilities = [...hits.values()].sort((x, y) => y.severity - x.severity);
      }
    }
  }
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : url + "/";
}

function mapDependencyGroups(manifest: VersionManifest | undefined): PackageDependencyGroup[] {
  if (!manifest) return [];
  const groups: PackageDependencyGroup[] = [];
  const push = (kind: string, deps: Record<string, string> | undefined) => {
    if (!deps || Object.keys(deps).length === 0) return;
    groups.push({
      kind,
      dependencies: Object.entries(deps).map(([id, range]) => ({ id, range }))
    });
  };
  push("dependencies", manifest.dependencies);
  push("peerDependencies", manifest.peerDependencies);
  push("optionalDependencies", manifest.optionalDependencies);
  return groups;
}

function normalizeAuthors(manifest: VersionManifest | undefined): string[] {
  if (!manifest) return [];
  if (typeof manifest.author === "string") return [manifest.author];
  if (manifest.author?.name) return [manifest.author.name];
  if (manifest.maintainers?.length) return manifest.maintainers.map((m) => m.name);
  return [];
}

function licenseString(license: VersionManifest["license"]): string | undefined {
  if (!license) return undefined;
  if (typeof license === "string") return license === "UNKNOWN" ? undefined : license;
  return license.type;
}

function repositoryUrl(repo: VersionManifest["repository"]): string | undefined {
  if (!repo) return undefined;
  const raw = typeof repo === "string" ? repo : repo.url;
  if (!raw) return undefined;
  return raw
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/^git:\/\//, "https://");
}

function trimReadme(readme: string | undefined): string | undefined {
  if (!readme) return undefined;
  if (/no readme data/i.test(readme.trim())) return undefined;
  return readme.length > 20_000 ? readme.slice(0, 20_000) + "\n\n…" : readme;
}

/** npm percent-encodes the `/` in a scoped package name but keeps the scope literal: `@types/node` -> `@types%2fnode`. */
function packageUrlSegment(id: string): string {
  if (id.startsWith("@")) {
    const slash = id.indexOf("/");
    if (slash > 0) {
      return `${id.slice(0, slash)}%2f${encodeURIComponent(id.slice(slash + 1))}`;
    }
  }
  return encodeURIComponent(id);
}
