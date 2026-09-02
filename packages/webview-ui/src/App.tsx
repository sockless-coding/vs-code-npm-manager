import * as React from "react";
import type {
  DependencyType,
  InstallAction,
  InstalledPackage,
  PackageDetail,
  PackageSummary,
  ProjectInfo,
  RegistryInfo,
  VersionPrefix
} from "@npm-manager/shared";
import { onHostEvent, onInstalledEnriched, onProgress, onScopeChange, request } from "./hostBridge";
import { detectVersionPrefix, stripVersionPin } from "@npm-manager/shared";
import { PackageList, buildInstalledTree, installedToRow, summaryToRow } from "./components/PackageList";
import { PackageDetails } from "./components/PackageDetails";

type Tab = "browse" | "installed" | "updates" | "consolidate";
const ALL_REGISTRIES = "All registries";
const PAGE_SIZE = 25;

export function App() {
  const [tab, setTab] = React.useState<Tab>("browse");
  const [includePrerelease, setIncludePrerelease] = React.useState(false);
  const [minPackageAgeDays, setMinPackageAgeDays] = React.useState(0);
  const [source, setSource] = React.useState(ALL_REGISTRIES);
  const [registries, setRegistries] = React.useState<RegistryInfo[]>([]);
  const [projects, setProjects] = React.useState<ProjectInfo[]>([]);
  const [preselectProjects, setPreselectProjects] = React.useState<string[]>([]);
  const [initializableDirs, setInitializableDirs] = React.useState<{ dir: string; name: string }[]>([]);
  const [initializing, setInitializing] = React.useState(false);

  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<PackageSummary[]>([]);
  const [hasMore, setHasMore] = React.useState(false);
  const [searching, setSearching] = React.useState(false);

  const [installed, setInstalled] = React.useState<InstalledPackage[]>([]);
  const [includeTransitive, setIncludeTransitive] = React.useState(false);
  const [installedLoading, setInstalledLoading] = React.useState(false);
  const [enriching, setEnriching] = React.useState(false);
  const [packageManagerAvailable, setPackageManagerAvailable] = React.useState(true);

  const [selectedId, setSelectedId] = React.useState<string | undefined>();
  const [detail, setDetail] = React.useState<PackageDetail | undefined>();
  const [detailLoading, setDetailLoading] = React.useState(false);

  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState<string | undefined>();
  const [toast, setToast] = React.useState<string | undefined>();

  const searchSeq = React.useRef(0);

  /* ---------------------------- initial load ---------------------------- */
  const loadInitialState = React.useCallback(() => {
    request({ kind: "ready" }).then((r) => {
      setIncludePrerelease(r.initialState.defaultIncludePrerelease);
      setMinPackageAgeDays(r.initialState.minimumPackageAgeDays);
      setRegistries(r.initialState.registries);
      setProjects(r.initialState.projects);
      setPreselectProjects(r.initialState.preselectProjectPaths ?? []);
      setInitializableDirs(r.initialState.initializableDirs ?? []);
    });
  }, []);

  const createPackageJson = React.useCallback(async (dir: string) => {
    setInitializing(true);
    try {
      const r = await request({ kind: "initPackageJson", dir });
      setInitializableDirs((prev) => prev.filter((d) => d.dir !== dir));
      setPreselectProjects([r.project.path]);
      const list = await request({ kind: "listProjects" });
      setProjects(list.projects);
      setTab("installed");
    } catch (e: any) {
      setToast(String(e?.message ?? e));
    } finally {
      setInitializing(false);
    }
  }, []);

  React.useEffect(() => {
    loadInitialState();
    const offEvent = onHostEvent((event) => {
      if (event === "projectsChanged") {
        request({ kind: "listProjects" }).then((r) => setProjects(r.projects));
      }
      if (event === "installedChanged") {
        refreshInstalled();
      }
      if (event === "settingsChanged") {
        loadInitialState();
        refreshInstalled();
      }
    });
    const offProgress = onProgress((message, done) => setProgress(done ? undefined : message));
    const offEnriched = onInstalledEnriched((phase, packages) => {
      setInstalled(packages);
      if (phase === "updates" || phase === "done") setEnriching(false);
    });
    const offScope = onScopeChange((paths) => setPreselectProjects(paths));
    return () => {
      offEvent();
      offProgress();
      offEnriched();
      offScope();
    };
  }, []);

  /* ------------------------------- search ------------------------------- */
  const runSearch = React.useCallback(
    async (q: string, append: boolean) => {
      const seq = ++searchSeq.current;
      setSearching(true);
      try {
        const skip = append ? results.length : 0;
        const r = await request({
          kind: "search",
          query: q,
          skip,
          take: PAGE_SIZE,
          includePrerelease,
          source
        });
        if (seq !== searchSeq.current) return;
        setResults((prev) => (append ? [...prev, ...r.results] : r.results));
        setHasMore(r.hasMore);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    },
    [results.length, includePrerelease, source]
  );

  React.useEffect(() => {
    if (tab !== "browse") return;
    const handle = setTimeout(() => runSearch(query, false), 300);
    return () => clearTimeout(handle);
  }, [query, includePrerelease, source, tab]);

  /* --------------------------- installed / updates --------------------- */
  const refreshInstalled = React.useCallback(async () => {
    setInstalledLoading(true);
    setEnriching(true);
    try {
      const r = await request({ kind: "listInstalled", includeTransitive });
      setInstalled(r.packages);
      setPackageManagerAvailable(r.packageManagerAvailable);
    } finally {
      setInstalledLoading(false);
    }
  }, [includeTransitive]);

  React.useEffect(() => {
    refreshInstalled();
  }, [includeTransitive]);

  /** The Updates tab is just the installed packages with a newer version available. */
  const updates = React.useMemo(
    () =>
      installed.filter(
        (p) =>
          !p.transitive &&
          p.latestVersion &&
          p.latestVersion !== stripVersionPin(p.requestedVersion)
      ),
    [installed]
  );

  /* ------------------------------- detail ------------------------------ */
  React.useEffect(() => {
    if (!selectedId) {
      setDetail(undefined);
      return;
    }
    setDetailLoading(true);
    let cancelled = false;
    request({ kind: "getPackageDetail", packageId: selectedId, source, includePrerelease })
      .then((r) => !cancelled && setDetail(r.detail))
      .catch((e) => !cancelled && setToast(String(e.message ?? e)))
      .finally(() => !cancelled && setDetailLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selectedId, source, includePrerelease]);

  /* ------------------------------ mutate ------------------------------- */
  const onMutate = async (
    action: InstallAction,
    version: string,
    projectPaths: string[],
    dependencyType: DependencyType,
    versionPrefix: VersionPrefix
  ) => {
    if (projectPaths.length === 0) return;
    setBusy(true);
    setToast(undefined);
    try {
      const r = await request({
        kind: "mutate",
        request: {
          action,
          packageId: selectedId!,
          version,
          projectPaths,
          source: detail?.source,
          dependencyType,
          versionPrefix
        }
      });
      const failed = r.result.perProject.filter((p) => !p.ok);
      if (r.result.ok) {
        setToast(
          `${labelFor(action)} ${r.result.packageId}${r.result.installNeeded ? " — run an install to finish" : ""}`
        );
      } else {
        setToast(`${labelFor(action)} failed for ${failed.map((f) => f.project).join(", ")}: ${failed[0]?.message ?? ""}`);
      }
      await refreshInstalled();
    } catch (e: any) {
      setToast(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const updateAll = async () => {
    const doUpdate = updates.filter((p) => p.latestVersion && !p.latestBelowMinAge && !p.pinned);
    const heldBack = updates.filter((p) => p.latestBelowMinAge && !p.pinned).length;
    const heldBackPinned = updates.filter((p) => p.pinned).length;
    setBusy(true);
    let done = 0;
    for (const pkg of doUpdate) {
      try {
        await request({
          kind: "mutate",
          request: {
            action: "update",
            packageId: pkg.id,
            version: pkg.latestVersion!,
            projectPaths: pkg.projects,
            // Keep each package's existing range style rather than forcing caret.
            versionPrefix: detectVersionPrefix(pkg.projectVersions[0]?.version || pkg.requestedVersion)
          }
        });
        done++;
      } catch {
        /* keep going */
      }
    }
    setBusy(false);
    const notes = [
      heldBack > 0 ? `${heldBack} newer than the ${minPackageAgeDays}-day minimum age` : "",
      heldBackPinned > 0 ? `${heldBackPinned} pinned` : ""
    ].filter(Boolean);
    setToast(
      `Updated ${done} package${done === 1 ? "" : "s"}` +
        (notes.length > 0 ? ` — held back: ${notes.join(", ")}` : "")
    );
    await refreshInstalled();
  };

  /* --------------------------- derived rows --------------------------- */
  const consolidatable = React.useMemo(() => groupInconsistent(installed), [installed]);
  const vulnerableCount = React.useMemo(
    () => installed.filter((p) => p.hasVulnerability).length,
    [installed]
  );
  const installedIsTree = tab === "installed" && includeTransitive;

  const rows =
    tab === "browse"
      ? results.map((p) => summaryToRow(p, minPackageAgeDays))
      : tab === "installed"
      ? installedIsTree
        ? buildInstalledTree(installed)
        : installed.map(installedToRow)
      : tab === "updates"
      ? updates.map(installedToRow)
      : consolidatable.map(installedToRow);

  const listLoading =
    tab === "browse"
      ? searching
      : tab === "updates"
      ? installedLoading || enriching
      : tab === "installed" || tab === "consolidate"
      ? installedLoading
      : false;

  return (
    <div className="app">
      <header className="toolbar">
        <div className="search-box">
          <span className="codicon codicon-search" />
          <input
            type="text"
            placeholder="Search packages (e.g. express)"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setTab("browse");
            }}
          />
        </div>
        <label className="prerelease-toggle">
          <input type="checkbox" checked={includePrerelease} onChange={(e) => setIncludePrerelease(e.target.checked)} />
          Include prerelease
        </label>
        <label className="source-select">
          Registry
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value={ALL_REGISTRIES}>{ALL_REGISTRIES}</option>
            {registries.filter((r) => r.enabled).map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
                {r.requiresAuth ? " 🔒" : ""}
              </option>
            ))}
          </select>
        </label>
      </header>

      <nav className="tabs">
        <button className={"tab" + (tab === "browse" ? " active" : "")} onClick={() => setTab("browse")}>
          Browse
        </button>
        <button className={"tab" + (tab === "installed" ? " active" : "")} onClick={() => setTab("installed")}>
          Installed <span className="count">{installed.length}</span>
          {vulnerableCount > 0 && (
            <span className="count vuln" title={`${vulnerableCount} package(s) with known vulnerabilities`}>
              <span className="codicon codicon-warning" /> {vulnerableCount}
            </span>
          )}
        </button>
        <button className={"tab" + (tab === "updates" ? " active" : "")} onClick={() => setTab("updates")}>
          Updates {updates.length > 0 && <span className="count accent">{updates.length}</span>}
        </button>
        <button className={"tab" + (tab === "consolidate" ? " active" : "")} onClick={() => setTab("consolidate")}>
          Consolidate {consolidatable.length > 0 && <span className="count">{consolidatable.length}</span>}
        </button>
        <span className="spacer" />
        {tab === "installed" && (
          <label className="transitive-toggle">
            <input type="checkbox" checked={includeTransitive} onChange={(e) => setIncludeTransitive(e.target.checked)} />
            Include transitive
          </label>
        )}
        {tab === "updates" && updates.length > 0 && (
          <button className="primary" disabled={busy} onClick={updateAll}>
            Update All
          </button>
        )}
      </nav>

      {!packageManagerAvailable && (
        <div className="banner">
          No npm/yarn/pnpm executable detected — changes are written directly to package.json. Run an
          install afterwards.
        </div>
      )}
      {progress && <div className="banner">{progress}</div>}
      {initializableDirs.length > 0 && (
        <div className="banner">
          {initializableDirs.map((d) => (
            <span key={d.dir} className="init-project">
              No <code>package.json</code> in <strong>{d.name}</strong>.{" "}
              <button className="link" disabled={initializing} onClick={() => createPackageJson(d.dir)}>
                Create package.json
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="content">
        <div className="list-pane">
          <PackageList
            rows={rows}
            selectedId={selectedId}
            loading={listLoading}
            loadingMessage={tab === "browse" ? "Searching…" : "Reading package.json files…"}
            tree={installedIsTree}
            emptyMessage={emptyMessageFor(tab, query)}
            onSelect={setSelectedId}
            onLoadMore={() => runSearch(query, true)}
            hasMore={tab === "browse" && hasMore}
          />
        </div>
        <div className="detail-pane">
          {detailLoading && <div className="loading">Loading package…</div>}
          {!detailLoading && detail && (
            <PackageDetails
              detail={detail}
              projects={projects}
              preselectProjectPaths={preselectProjects}
              installed={installed}
              includePrerelease={includePrerelease}
              minPackageAgeDays={minPackageAgeDays}
              busy={busy}
              onMutate={onMutate}
              onSelectPackage={setSelectedId}
            />
          )}
          {!detailLoading && !detail && <div className="empty">Select a package to see details.</div>}
        </div>
      </div>

      {toast && (
        <div className="toast" onClick={() => setToast(undefined)}>
          {toast}
        </div>
      )}
    </div>
  );
}

function labelFor(action: InstallAction): string {
  switch (action) {
    case "install":
      return "Installed";
    case "update":
      return "Updated";
    case "uninstall":
      return "Uninstalled";
    case "pin":
      return "Pinned";
    case "unpin":
      return "Unpinned";
  }
}

function emptyMessageFor(tab: Tab, query: string): string {
  switch (tab) {
    case "browse":
      return query ? "No packages match your search." : "Type to search the configured npm registries.";
    case "installed":
      return "No packages installed in this workspace.";
    case "updates":
      return "All packages are up to date.";
    case "consolidate":
      return "All packages use a consistent version across package.json files.";
  }
}

/** Packages referenced at more than one distinct version across package.json files. */
function groupInconsistent(installed: InstalledPackage[]): InstalledPackage[] {
  return installed.filter((p) => {
    if (p.transitive) return false;
    const distinct = new Set(p.projectVersions.map((pv) => pv.version));
    return distinct.size > 1;
  });
}
