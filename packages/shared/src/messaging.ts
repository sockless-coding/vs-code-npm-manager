/**
 * Typed message protocol between the extension host and the webview.
 *
 * The webview sends `WebviewRequest` messages; the host answers a request with a
 * `HostResponse` carrying the same `id`, and may also push unsolicited `HostEvent`
 * messages (e.g. project changes detected on disk).
 */

import type { VersionPrefix } from "./versionRange";

export type DependencyType = "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies";

/**
 * How a chosen version is written to package.json: `^1.2.3`, `~1.2.3`, `1.2.3`,
 * or `>=1.2.3`. Defined in `./versionRange` alongside the helpers that apply it;
 * re-exported here so the message contract stays in one place.
 */
export type { VersionPrefix };

/**
 * One resolved `npm audit` advisory. `range`/`title` come from the advisory that
 * actually carries the CVE — which, for a package that is only vulnerable because
 * of a dependency several hops down its own tree, may not be the package this
 * advisory is attached to; see `collectAdvisories` in `projects/installed.ts`.
 */
export interface VulnerabilityInfo {
  /** 0 Low, 1 Moderate, 2 High, 3 Critical. */
  severity: number;
  advisoryUrl: string;
  title?: string;
  /** The vulnerable version range this specific advisory applies to. */
  range?: string;
}

/** Map an npm severity word (`info`/`low`/`moderate`/`high`/`critical`) to the 0..3 rank used by {@link VulnerabilityInfo.severity}. */
export const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 0,
  moderate: 1,
  high: 2,
  critical: 3
};

export interface PackageSummary {
  id: string;
  version: string;
  description: string;
  authors: string[];
  iconUrl?: string;
  totalDownloads?: number;
  verified?: boolean;
  projectUrl?: string;
  licenseUrl?: string;
  licenseExpression?: string;
  tags?: string[];
  /** Source registry name this result came from. */
  source: string;
  /** Publish date of `version`, when known — used to flag freshly released packages. */
  latestPublished?: string;
}

export interface PackageDependency {
  id: string;
  range: string;
}

export interface PackageDependencyGroup {
  /** "dependencies" | "peerDependencies" | "optionalDependencies". */
  kind: string;
  dependencies: PackageDependency[];
}

export interface PackageDetail {
  id: string;
  /** All versions, already sorted newest-first by semver rules. */
  versions: VersionInfo[];
  selectedVersion: string;
  description: string;
  authors: string[];
  iconUrl?: string;
  projectUrl?: string;
  licenseUrl?: string;
  licenseExpression?: string;
  readmeMarkdown?: string;
  tags: string[];
  dependencyGroups: PackageDependencyGroup[];
  deprecation?: { reasons: string[]; message?: string; alternatePackageId?: string };
  vulnerabilities?: VulnerabilityInfo[];
  source: string;
}

export interface VersionInfo {
  version: string;
  isPrerelease: boolean;
  downloads?: number;
  published?: string;
  /** The `deprecated` message from the packument for this exact version, when set. */
  deprecated?: string;
  /**
   * Advisories whose vulnerable range covers this exact version, worst-first.
   * Populated from the registry's bulk advisory endpoint when the detail view
   * is opened; absent when the endpoint is unavailable (e.g. a private registry
   * that does not implement it).
   */
  vulnerabilities?: VulnerabilityInfo[];
}

export interface ProjectInfo {
  /** Absolute path to package.json. */
  path: string;
  name: string;
  /** Path to the root package.json of the npm/yarn/pnpm workspace that contains this one, if any. */
  workspaceRoot?: string;
  packageManager: "npm" | "yarn" | "pnpm";
  isWorkspaceRoot: boolean;
}

export interface InstalledPackage {
  id: string;
  /** Requested version / range as written in package.json (e.g. "^1.2.3"). */
  requestedVersion: string;
  /** Resolved version from the lockfile / node_modules, when known. */
  resolvedVersion?: string;
  /** package.json paths that reference this package directly. */
  projects: string[];
  /** Direct reference version per project — basis for the Consolidate view. */
  projectVersions: { project: string; version: string; pinned?: boolean; dependencyType?: DependencyType }[];
  /** True when only present transitively (not a direct dependency anywhere). */
  transitive: boolean;
  latestVersion?: string;
  latestStableVersion?: string;
  deprecated?: boolean;
  hasVulnerability?: boolean;
  /** Package icon — resolved best-effort; usually absent for npm packages. */
  iconUrl?: string;
  /**
   * Known advisories affecting the installed version — including ones that only
   * apply because of a package deeper in this one's own dependency tree, resolved
   * recursively so the full exposure shows up here without drilling into every
   * transitive package individually. Sorted worst-first.
   */
  vulnerabilities?: VulnerabilityInfo[];
  /** Highest advisory severity (0..3), or -1 when there are none. */
  maxVulnerabilitySeverity?: number;
  /** Project paths where the resolved version is flagged vulnerable. */
  vulnerableProjects?: string[];
  /** Package ids in the resolved graph that depend directly on this package. */
  requiredBy?: string[];
  /** Package ids this package depends on directly (resolved graph). */
  dependsOn?: string[];
  /** Publish date of `latestVersion`, when known. */
  latestPublished?: string;
  /** True when `latestVersion` is newer than the configured minimum package age. */
  latestBelowMinAge?: boolean;
  /**
   * True when every direct reference is an exact-version pin (no `^`/`~`/range).
   * Pinned packages are held back from "Update All"; vulnerability checks still apply.
   */
  pinned?: boolean;
  /** The pinned version when all direct references pin the same exact version. */
  pinnedVersion?: string;
}

export interface RegistryInfo {
  name: string;
  url: string;
  enabled: boolean;
  requiresAuth: boolean;
}

export type InstallAction = "install" | "update" | "uninstall" | "pin" | "unpin";

export interface MutationRequest {
  action: InstallAction;
  packageId: string;
  version?: string;
  projectPaths: string[];
  source?: string;
  /** Where a fresh install should be written; ignored for update/uninstall/pin/unpin. */
  dependencyType?: DependencyType;
  /** How to write `version`; only used for install/update — pin/unpin always use exact/caret. Defaults to "caret". */
  versionPrefix?: VersionPrefix;
}

export interface MutationResult {
  ok: boolean;
  action: InstallAction;
  packageId: string;
  perProject: { project: string; ok: boolean; message?: string }[];
  usedFallback: boolean;
  installNeeded: boolean;
}

/* ------------------------------- Requests -------------------------------- */

export type WebviewRequest =
  | { kind: "ready" }
  | { kind: "search"; query: string; skip: number; take: number; includePrerelease: boolean; source: string }
  | { kind: "getPackageDetail"; packageId: string; source: string; includePrerelease: boolean }
  | { kind: "listProjects" }
  | { kind: "listInstalled"; includeTransitive: boolean }
  | { kind: "listRegistries" }
  | { kind: "mutate"; request: MutationRequest }
  | { kind: "initPackageJson"; dir: string }
  | { kind: "openExternal"; url: string };

export type WebviewMessage = WebviewRequest & { id: number };

/* ------------------------------- Responses ------------------------------- */

export type HostResponsePayload =
  | { kind: "search"; results: PackageSummary[]; hasMore: boolean }
  | { kind: "getPackageDetail"; detail: PackageDetail }
  | { kind: "listProjects"; projects: ProjectInfo[] }
  | { kind: "listInstalled"; packages: InstalledPackage[]; packageManagerAvailable: boolean }
  | { kind: "listRegistries"; registries: RegistryInfo[] }
  | { kind: "mutate"; result: MutationResult }
  | { kind: "initPackageJson"; project: ProjectInfo }
  | { kind: "openExternal" }
  | { kind: "ready"; initialState: InitialState };

export interface InitialState {
  defaultIncludePrerelease: boolean;
  registries: RegistryInfo[];
  projects: ProjectInfo[];
  /** Minimum age in days before a package version is trusted; 0 disables the check. */
  minimumPackageAgeDays: number;
  /**
   * package.json paths to preselect for install/update, based on the file the
   * manager was opened from. Empty when opened without a specific scope (e.g. the
   * command palette).
   */
  preselectProjectPaths: string[];
  /**
   * Directories the manager was opened on that have no `package.json` yet. The
   * webview offers to create one (see the `initPackageJson` request). Empty in
   * the common case.
   */
  initializableDirs?: { dir: string; name: string }[];
}

export type HostResponse =
  | { id: number; ok: true; payload: HostResponsePayload }
  | { id: number; ok: false; error: string };

export type HostEvent =
  | { type: "event"; event: "projectsChanged" }
  | { type: "event"; event: "installedChanged" }
  | { type: "event"; event: "settingsChanged" }
  | { type: "event"; event: "scopeChanged"; preselectProjectPaths: string[] }
  | { type: "event"; event: "progress"; message: string; done: boolean }
  | {
      type: "event";
      event: "installedEnriched";
      phase: "updates" | "vulnerabilities" | "done";
      packages: InstalledPackage[];
    };

export type HostMessage = ({ type: "response" } & HostResponse) | HostEvent;
