import * as React from "react";
import type {
  DependencyType,
  InstallAction,
  InstalledPackage,
  PackageDetail,
  ProjectInfo,
  VersionPrefix,
  VulnerabilityInfo
} from "../../panel/messaging";
import { formatDate, formatDownloads, severityLabel } from "../format";
import { ageInDays, formatRelativeAge, pickDefaultVersion } from "../packageAge";
import {
  VERSION_PREFIXES,
  VERSION_PREFIX_LABELS,
  detectVersionPrefix,
  isExactVersionPin,
  stripVersionPin
} from "../../npm/versionRange";
import { request } from "../vscodeApi";

interface Props {
  detail: PackageDetail;
  projects: ProjectInfo[];
  /** Projects to preselect based on the file the manager was opened from. */
  preselectProjectPaths: string[];
  installed: InstalledPackage[];
  includePrerelease: boolean;
  minPackageAgeDays: number;
  busy: boolean;
  onMutate: (
    action: InstallAction,
    version: string,
    projectPaths: string[],
    dependencyType: DependencyType,
    versionPrefix: VersionPrefix
  ) => void;
  onSelectPackage: (id: string) => void;
}

const DEPENDENCY_TYPE_LABELS: Record<DependencyType, string> = {
  dependencies: "Dependencies",
  devDependencies: "Dev Dependencies",
  peerDependencies: "Peer Dependencies",
  optionalDependencies: "Optional Dependencies"
};

const DEPENDENCY_TYPE_TAGS: Record<DependencyType, string> = {
  dependencies: "",
  devDependencies: "dev",
  peerDependencies: "peer",
  optionalDependencies: "optional"
};

export function PackageDetails({
  detail,
  projects,
  preselectProjectPaths,
  installed,
  includePrerelease,
  minPackageAgeDays,
  busy,
  onMutate,
  onSelectPackage
}: Props) {
  const installedForPackage = installed.find((p) => p.id.toLowerCase() === detail.id.toLowerCase());
  const installedProjectPaths = new Set(installedForPackage?.projects ?? []);
  const vulnerableProjectPaths = new Set(
    installedForPackage?.vulnerableProjects?.length
      ? installedForPackage.vulnerableProjects
      : installedForPackage?.hasVulnerability
      ? installedForPackage.projects
      : []
  );

  const visibleVersions = detail.versions.filter((v) => includePrerelease || !v.isPrerelease);
  // For an installed package, default the version picker to the version it is
  // currently at (so "Pin" locks the current version and "Update" is an explicit
  // choice); otherwise use the supply-chain-aware default for a fresh install.
  const installedVersion = installedForPackage
    ? stripVersionPin(
        installedForPackage.pinnedVersion ||
          installedForPackage.projectVersions[0]?.version ||
          installedForPackage.requestedVersion ||
          installedForPackage.resolvedVersion ||
          ""
      )
    : "";
  const defaultVersion =
    installedVersion && detail.versions.some((v) => v.version === installedVersion)
      ? installedVersion
      : pickDefaultVersion(detail.versions, includePrerelease, minPackageAgeDays);
  const [version, setVersion] = React.useState(defaultVersion);
  React.useEffect(
    () => setVersion(defaultVersion),
    [detail.id, defaultVersion]
  );

  const [dependencyType, setDependencyType] = React.useState<DependencyType>("dependencies");
  React.useEffect(() => setDependencyType("dependencies"), [detail.id]);

  // Default the selector to whatever range style the package is already
  // installed with, so a plain "Update" doesn't silently change it; a fresh
  // install defaults to a caret range, npm's own default.
  const defaultPrefix = installedForPackage
    ? detectVersionPrefix(
        installedForPackage.projectVersions[0]?.version || installedForPackage.requestedVersion
      )
    : "caret";
  const [versionPrefix, setVersionPrefix] = React.useState<VersionPrefix>(defaultPrefix);
  React.useEffect(() => setVersionPrefix(defaultPrefix), [detail.id, defaultPrefix]);

  const selectedInfo = detail.versions.find((v) => v.version === version);
  const selectedAgeDays = ageInDays(selectedInfo?.published);
  const selectedBelowMinAge = minPackageAgeDays > 0 && selectedAgeDays < minPackageAgeDays;

  const [selectedProjects, setSelectedProjects] = React.useState<Set<string>>(new Set());
  const scopeKey = preselectProjectPaths.join("|");
  React.useEffect(() => {
    // Preselection priority:
    //   1. the scope the manager was opened from (a package.json or workspace root),
    //   2. projects that already have the package (for update/uninstall),
    //   3. every project (for a fresh install).
    const known = new Set(projects.map((p) => p.path));
    const scoped = preselectProjectPaths.filter((p) => known.has(p));
    setSelectedProjects(
      scoped.length > 0
        ? new Set(scoped)
        : installedProjectPaths.size > 0
        ? new Set(installedProjectPaths)
        : new Set(projects.map((p) => p.path))
    );
  }, [detail.id, projects.length, scopeKey]);

  const allSelected = projects.length > 0 && projects.every((p) => selectedProjects.has(p.path));
  const someSelected = projects.some((p) => selectedProjects.has(p.path));
  const selectAllRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected && !allSelected;
    }
  }, [someSelected, allSelected]);

  const toggleAllProjects = () => {
    setSelectedProjects(allSelected ? new Set() : new Set(projects.map((p) => p.path)));
  };

  const toggleProject = (path: string) => {
    setSelectedProjects((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  };

  const projectPinned = (path: string): boolean =>
    !!installedForPackage?.projectVersions.find((pv) => pv.project === path)?.pinned;

  const chosen = [...selectedProjects];
  const anyChosen = chosen.length > 0;
  const chosenInstalled = chosen.filter((p) => installedProjectPaths.has(p));
  const chosenNotInstalled = chosen.filter((p) => !installedProjectPaths.has(p));
  const chosenPinned = chosenInstalled.filter(projectPinned);
  const chosenUnpinned = chosenInstalled.filter((p) => !projectPinned(p));

  const canInstall = anyChosen && chosenNotInstalled.length > 0;
  const canUpdate =
    anyChosen &&
    chosenInstalled.length > 0 &&
    chosenInstalled.some((path) => {
      const raw =
        installedForPackage?.projectVersions.find((pv) => pv.project === path)?.version ??
        installedForPackage?.requestedVersion ??
        "";
      // Actionable when either the version number or the range style (^, ~, exact, >=) changes.
      return stripVersionPin(raw) !== version || detectVersionPrefix(raw) !== versionPrefix;
    });
  const canUninstall = anyChosen && chosenInstalled.length > 0;
  const canPin = anyChosen && chosenUnpinned.length > 0;
  const canUnpin = anyChosen && chosenPinned.length > 0;
  const pinnedAndVulnerable = !!installedForPackage?.pinned && !!installedForPackage?.hasVulnerability;

  return (
    <div className="pkg-detail">
      <div className="pkg-detail-header">
        {detail.iconUrl ? (
          <img className="pkg-detail-icon" src={detail.iconUrl} alt="" />
        ) : (
          <span className="codicon codicon-package pkg-detail-icon" />
        )}
        <div>
          <h2>{detail.id}</h2>
          <div className="muted">
            {detail.authors.length > 0 && <span>by {detail.authors.join(", ")}</span>}
            {detail.source && <span className="chip">{detail.source}</span>}
          </div>
        </div>
      </div>

      {detail.deprecation && (
        <div className="callout callout-warn">
          <strong>Deprecated.</strong> {detail.deprecation.message || detail.deprecation.reasons.join(", ")}
        </div>
      )}
      {detail.vulnerabilities && detail.vulnerabilities.length > 0 && (
        <div className="callout callout-error">
          <strong>Known vulnerabilities:</strong>
          <ul className="advisories">{detail.vulnerabilities.map((v, i) => <AdvisoryItem key={i} v={v} />)}</ul>
        </div>
      )}
      {installedForPackage?.vulnerabilities && installedForPackage.vulnerabilities.length > 0 && (
        <div className="callout callout-error">
          <strong>
            The installed{installedForPackage.transitive ? " (transitive)" : ""} version has{" "}
            {installedForPackage.vulnerabilities.length === 1 ? "an advisory" : "advisories"}, including any
            from its own dependencies:
          </strong>
          <ul className="advisories">
            {installedForPackage.vulnerabilities.map((v, i) => <AdvisoryItem key={i} v={v} />)}
          </ul>
        </div>
      )}
      {pinnedAndVulnerable && (
        <div className="callout callout-error">
          <strong>Pinned &amp; vulnerable.</strong> This package is pinned to{" "}
          <code>{installedForPackage?.pinnedVersion ?? "an exact version"}</code>, so it is held back
          from <em>Update All</em> — but the pinned version has a known advisory. Choose a fixed
          version above and <em>Update</em> (it stays pinned), or <em>Unpin</em> to let it float.
        </div>
      )}
      {!pinnedAndVulnerable && installedForPackage?.pinned && (
        <div className="callout callout-warn">
          <strong>Pinned.</strong> Referenced as{" "}
          <code>{installedForPackage.pinnedVersion ?? "an exact version"}</code> and held back from{" "}
          <em>Update All</em>. <em>Unpin</em> to allow updates (<code>^{installedForPackage.pinnedVersion}</code>);
          vulnerability checks still apply either way.
        </div>
      )}
      {selectedBelowMinAge && (
        <div className="callout callout-warn">
          <strong>Freshly released.</strong> Version {version} was published{" "}
          {formatRelativeAge(selectedInfo?.published)} — within your {minPackageAgeDays}-day minimum
          package age (<code>npmManager.minimumPackageAgeDays</code>). New releases are the highest-risk
          window for a compromised package; prefer an older version unless you have a reason to take
          this one.
        </div>
      )}

      <div className="pkg-detail-controls">
        <label>
          Version
          <select value={version} onChange={(e) => setVersion(e.target.value)} disabled={busy}>
            {visibleVersions.map((v) => {
              const tooNew = minPackageAgeDays > 0 && ageInDays(v.published) < minPackageAgeDays;
              return (
                <option key={v.version} value={v.version}>
                  {v.version}
                  {v.isPrerelease ? "  (prerelease)" : ""}
                  {v.published ? `  · ${formatDate(v.published)}` : ""}
                  {tooNew ? `  · released ${formatRelativeAge(v.published)}` : ""}
                </option>
              );
            })}
          </select>
        </label>
        {(canInstall || canUpdate) && (
          <label>
            Save as
            <select value={versionPrefix} onChange={(e) => setVersionPrefix(e.target.value as VersionPrefix)} disabled={busy}>
              {VERSION_PREFIXES.map((p) => (
                <option key={p} value={p}>
                  {VERSION_PREFIX_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
        )}
        {canInstall && (
          <label>
            Add as
            <select value={dependencyType} onChange={(e) => setDependencyType(e.target.value as DependencyType)} disabled={busy}>
              {(Object.keys(DEPENDENCY_TYPE_LABELS) as DependencyType[]).map((t) => (
                <option key={t} value={t}>
                  {DEPENDENCY_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="button-row">
          <button
            disabled={busy || !canInstall}
            onClick={() => onMutate("install", version, chosenNotInstalled, dependencyType, versionPrefix)}
          >
            Install
          </button>
          <button
            disabled={busy || !canUpdate}
            onClick={() => onMutate("update", version, chosenInstalled, dependencyType, versionPrefix)}
          >
            Update
          </button>
          {canUnpin && (
            <button
              disabled={busy}
              title={`Change ${chosenPinned.length} project(s) from an exact version to a caret range`}
              onClick={() => onMutate("unpin", version, chosenPinned, dependencyType, versionPrefix)}
            >
              Unpin
            </button>
          )}
          {(!canUnpin || canPin) && (
            <button
              disabled={busy || !canPin}
              title={`Lock ${chosenUnpinned.length} project(s) to the exact version ${version}`}
              onClick={() => onMutate("pin", version, chosenUnpinned, dependencyType, versionPrefix)}
            >
              Pin
            </button>
          )}
          <button
            className="danger"
            disabled={busy || !canUninstall}
            onClick={() => onMutate("uninstall", version, chosenInstalled, dependencyType, versionPrefix)}
          >
            Uninstall
          </button>
        </div>
      </div>

      <div className="project-list">
        <div className="project-list-head">
          <span>
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={allSelected}
              onChange={toggleAllProjects}
              disabled={busy || projects.length === 0}
              title={allSelected ? "Deselect all projects" : "Select all projects"}
            />
            package.json
          </span>
          <span>Installed</span>
        </div>
        {projects.length === 0 && <div className="empty">No package.json found in this workspace.</div>}
        {projects.map((p) => {
          const pv = installedForPackage?.projectVersions.find((x) => x.project === p.path);
          const rawInst = pv?.version ?? (installedProjectPaths.has(p.path) ? installedForPackage?.requestedVersion ?? "—" : "—");
          const inst = rawInst === "—" ? "—" : stripVersionPin(rawInst);
          const pinned = isExactVersionPin(rawInst) || projectPinned(p.path);
          const vulnerable = vulnerableProjectPaths.has(p.path);
          const typeTag = pv?.dependencyType ? DEPENDENCY_TYPE_TAGS[pv.dependencyType] : "";
          return (
            <label key={p.path} className={"project-row" + (vulnerable ? " vulnerable" : "")}>
              <span>
                <input
                  type="checkbox"
                  checked={selectedProjects.has(p.path)}
                  onChange={() => toggleProject(p.path)}
                  disabled={busy}
                />
                {p.name}
                {vulnerable && (
                  <span
                    className="codicon codicon-warning vuln-mark"
                    title="This package.json resolves a vulnerable version of the package"
                  />
                )}
                <span className="chip" title="Package manager">{p.packageManager}</span>
                {p.isWorkspaceRoot && <span className="chip" title="Workspace root">workspace</span>}
                {typeTag && <span className="chip" title="Dependency type">{typeTag}</span>}
              </span>
              <span className={"project-installed" + (inst === "—" ? " muted" : "")}>
                {inst}
                {pinned && inst !== "—" && (
                  <span className="codicon codicon-pinned pin-mark" title="Pinned to this exact version" />
                )}
              </span>
            </label>
          );
        })}
      </div>

      {detail.description && <p className="pkg-detail-desc">{detail.description}</p>}

      <div className="pkg-detail-links">
        {detail.projectUrl && (
          <a href="#" onClick={(e) => (e.preventDefault(), request({ kind: "openExternal", url: detail.projectUrl! }))}>
            Project site
          </a>
        )}
        {detail.licenseExpression && <span className="muted">License: {detail.licenseExpression}</span>}
      </div>

      {installedForPackage?.requiredBy && installedForPackage.requiredBy.length > 0 && (
        <details className="deps" open>
          <summary>Required by (in your projects)</summary>
          <ul className="referenced-by">
            {installedForPackage.requiredBy.map((id) => (
              <li key={id}>
                <button className="link-button" onClick={() => onSelectPackage(id)}>
                  {id}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {detail.dependencyGroups.length > 0 && (
        <details className="deps">
          <summary>Dependencies</summary>
          {detail.dependencyGroups.map((g) => (
            <div key={g.kind}>
              <div className="deps-tfm">{DEPENDENCY_TYPE_LABELS[g.kind as DependencyType] ?? g.kind}</div>
              {g.dependencies.length === 0 ? (
                <div className="muted">No dependencies</div>
              ) : (
                <ul>
                  {g.dependencies.map((d) => (
                    <li key={d.id}>
                      {d.id} <span className="muted">{d.range}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </details>
      )}

      {detail.readmeMarkdown && (
        <details className="readme">
          <summary>Readme</summary>
          <pre>{detail.readmeMarkdown}</pre>
        </details>
      )}

      {(() => {
        const dl = detail.versions.find((x) => x.version === version)?.downloads;
        return dl ? <div className="muted small">{formatDownloads(dl)} downloads of this version</div> : null;
      })()}
    </div>
  );
}

/** One resolved advisory: severity, title, the range it applies to, and a link when known. */
function AdvisoryItem({ v }: { v: VulnerabilityInfo }) {
  return (
    <li>
      <span className={"severity-dot severity-" + severityLabel(v.severity).toLowerCase()} aria-hidden="true" />
      <strong>{severityLabel(v.severity)}</strong>
      {v.title ? ` ${v.title}` : ""}
      {v.range && <span className="muted"> — affects {v.range}</span>}
      {v.advisoryUrl && (
        <>
          {" "}
          <a href="#" onClick={(e) => (e.preventDefault(), request({ kind: "openExternal", url: v.advisoryUrl }))}>
            advisory
          </a>
        </>
      )}
    </li>
  );
}
