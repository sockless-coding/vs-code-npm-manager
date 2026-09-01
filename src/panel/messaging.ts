/**
 * Typed message protocol between the extension host and the webview.
 *
 * The webview sends `WebviewRequest` messages; the host answers a request with a
 * `HostResponse` carrying the same `id`, and may also push unsolicited `HostEvent`
 * messages (e.g. project changes detected on disk).
 */

export type DependencyType = "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies";

/** How a chosen version is written to package.json: `^1.2.3`, `~1.2.3`, `1.2.3`, or `>=1.2.3`. */
export type VersionPrefix = "exact" | "caret" | "tilde" | "gte";

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
  vulnerabilities?: { severity: number; advisoryUrl: string }[];
  source: string;
}

export interface VersionInfo {
  version: string;
  isPrerelease: boolean;
  downloads?: number;
  published?: string;
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
  /** Known advisories affecting the installed version (direct or transitive). */
  vulnerabilities?: { severity: number; advisoryUrl: string }[];
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
