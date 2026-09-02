import * as React from "react";
import type { InstalledPackage, PackageSummary } from "@npm-manager/shared";
import { formatDownloads } from "../format";
import { ageInDays } from "../packageAge";

export type RowBadge = "deprecated" | "vulnerable" | "new" | "pinned";

export interface ListRow {
  id: string;
  /** Unique key — the same package id can appear under several parents in the tree. */
  rowKey: string;
  title: string;
  description: string;
  authors: string[];
  iconUrl?: string;
  downloads?: number;
  verified?: boolean;
  rightLabel?: string;
  badges: RowBadge[];
  /** Highest advisory severity (0..3) when vulnerable. */
  severity?: number;
  /** Tooltip text summarizing the known advisories, worst first. */
  vulnerabilitySummary?: string;
  /** Direct packages that pull this one in (transitive rows in flat view). */
  via?: string[];
  /* tree layout */
  depth: number;
  parentKey?: string;
  hasChildren: boolean;
}

export function summaryToRow(p: PackageSummary, minAgeDays = 0): ListRow {
  const isNew = minAgeDays > 0 && ageInDays(p.latestPublished) < minAgeDays;
  return {
    id: p.id,
    rowKey: p.id,
    title: p.id,
    description: p.description,
    authors: p.authors,
    iconUrl: p.iconUrl,
    downloads: p.totalDownloads,
    verified: p.verified,
    badges: isNew ? ["new"] : [],
    depth: 0,
    hasChildren: false
  };
}

export function installedToRow(p: InstalledPackage): ListRow {
  const current = p.pinnedVersion || p.requestedVersion || p.resolvedVersion || "?";
  const right =
    p.latestVersion && p.latestVersion !== (p.pinnedVersion || p.requestedVersion)
      ? `${current} → ${p.latestVersion}`
      : current === "?"
      ? ""
      : current;

  const badges: RowBadge[] = [];
  if (p.hasVulnerability) badges.push("vulnerable");
  if (p.deprecated) badges.push("deprecated");
  if (p.pinned) badges.push("pinned");
  if (p.latestBelowMinAge) badges.push("new");

  return {
    id: p.id,
    rowKey: p.id,
    title: p.id,
    description: p.transitive
      ? "Transitive dependency"
      : `${p.projects.length} package.json${p.projects.length === 1 ? "" : "s"}`,
    authors: [],
    iconUrl: p.iconUrl,
    rightLabel: right,
    badges,
    severity: p.maxVulnerabilitySeverity,
    vulnerabilitySummary: vulnerabilitySummary(p),
    via: p.transitive ? p.requiredBy : undefined,
    depth: 0,
    hasChildren: false
  };
}

const SEVERITY_TITLES = ["low", "moderate", "high", "critical"];

/** Tooltip text for a vulnerable row: advisory count plus the worst one's title. */
function vulnerabilitySummary(p: InstalledPackage): string | undefined {
  const list = p.vulnerabilities;
  if (!list || list.length === 0) return undefined;
  const worst = list[0]; // applyAdvisories keeps this sorted worst-first.
  const label = SEVERITY_TITLES[worst.severity] ?? "known";
  const count = list.length > 1 ? `${list.length} advisories, worst: ` : "";
  return `${count}${label} severity${worst.title ? " — " + worst.title : ""}`;
}

/**
 * Ordered rows for the Installed tree: direct packages as roots, each transitive
 * package nested under the direct package(s) that pull it in. Cycle-guarded.
 */
export function buildInstalledTree(packages: InstalledPackage[]): ListRow[] {
  const byId = new Map(packages.map((p) => [p.id.toLowerCase(), p]));
  const directIds = new Set(packages.filter((p) => !p.transitive).map((p) => p.id.toLowerCase()));
  const rows: ListRow[] = [];

  const walk = (pkg: InstalledPackage, depth: number, parentKey: string | undefined, path: Set<string>) => {
    const key = parentKey ? `${parentKey}›${pkg.id}` : pkg.id;
    const children = (pkg.dependsOn ?? [])
      .map((id) => byId.get(id.toLowerCase()))
      .filter(
        (c): c is InstalledPackage =>
          !!c &&
          c.id.toLowerCase() !== pkg.id.toLowerCase() &&
          !path.has(c.id.toLowerCase()) &&
          !directIds.has(c.id.toLowerCase())
      );
    rows.push({
      ...installedToRow(pkg),
      rowKey: key,
      depth,
      parentKey,
      hasChildren: children.length > 0,
      via: undefined // nesting already conveys the parent
    });
    const nextPath = new Set(path).add(pkg.id.toLowerCase());
    for (const child of children) walk(child, depth + 1, key, nextPath);
  };

  for (const pkg of packages.filter((p) => !p.transitive)) walk(pkg, 0, undefined, new Set());

  const placed = new Set(rows.map((r) => r.id.toLowerCase()));
  for (const pkg of packages.filter((p) => p.transitive && !placed.has(p.id.toLowerCase()))) {
    rows.push({ ...installedToRow(pkg), rowKey: pkg.id });
  }
  return rows;
}

interface Props {
  rows: ListRow[];
  selectedId?: string;
  loading?: boolean;
  loadingMessage?: string;
  emptyMessage: string;
  tree?: boolean;
  onSelect: (id: string) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
}

export function PackageList({
  rows,
  selectedId,
  loading,
  loadingMessage,
  emptyMessage,
  tree,
  onSelect,
  onLoadMore,
  hasMore
}: Props) {
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());

  const visibleRows = React.useMemo(() => {
    if (!tree) return rows;
    const byKey = new Map(rows.map((r) => [r.rowKey, r]));
    const collapsedAncestor = (row: ListRow): boolean => {
      let key = row.parentKey;
      while (key) {
        if (collapsed.has(key)) return true;
        key = byKey.get(key)?.parentKey;
      }
      return false;
    };
    return rows.filter((r) => !collapsedAncestor(r));
  }, [rows, tree, collapsed]);

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  return (
    <div className="pkg-list" role="listbox" aria-label="Packages">
      {loading && visibleRows.length === 0 && (
        <div className="loading enumerating">
          <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />
          {loadingMessage ?? "Loading…"}
        </div>
      )}
      {!loading && visibleRows.length === 0 && <div className="empty">{emptyMessage}</div>}
      {visibleRows.map((row) => (
        <div
          key={row.rowKey}
          role="option"
          aria-selected={row.id === selectedId}
          className={"pkg-row" + (row.id === selectedId ? " selected" : "")}
          onClick={() => onSelect(row.id)}
          style={tree ? { paddingLeft: 10 + row.depth * 16 } : undefined}
        >
          {tree && (
            <span
              className={"pkg-row-twisty" + (row.hasChildren ? "" : " leaf")}
              onClick={(e) => {
                e.stopPropagation();
                if (row.hasChildren) toggle(row.rowKey);
              }}
              aria-hidden="true"
            >
              {row.hasChildren && (
                <span
                  className={
                    "codicon codicon-chevron-" + (collapsed.has(row.rowKey) ? "right" : "down")
                  }
                />
              )}
            </span>
          )}
          <div className="pkg-row-icon">
            {row.iconUrl ? (
              <img
                src={row.iconUrl}
                alt=""
                onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")}
              />
            ) : (
              <span className="codicon codicon-package" aria-hidden="true" />
            )}
          </div>
          <div className="pkg-row-body">
            <div className="pkg-row-title">
              <span className="pkg-row-id">{row.title}</span>
              {row.verified && (
                <span className="codicon codicon-verified-filled verified" title="Verified owner" />
              )}
              {row.badges.includes("vulnerable") && (
                <span className="badge badge-error" title={row.vulnerabilitySummary ?? "known vulnerability"}>
                  vulnerable
                </span>
              )}
              {row.badges.includes("deprecated") && <span className="badge badge-warn">deprecated</span>}
              {row.badges.includes("pinned") && (
                <span className="badge badge-pinned" title="Version is pinned — held back from Update All">
                  <span className="codicon codicon-pinned" /> pinned
                </span>
              )}
              {row.badges.includes("new") && (
                <span className="badge badge-new" title="Published within the minimum package age">
                  just released
                </span>
              )}
            </div>
            <div className="pkg-row-desc">{row.description}</div>
            <div className="pkg-row-meta">
              {row.via && row.via.length > 0 && (
                <span className="pkg-row-via" title={row.via.join(", ")}>
                  <span className="codicon codicon-references" /> via {row.via.slice(0, 3).join(", ")}
                  {row.via.length > 3 ? ` +${row.via.length - 3}` : ""}
                </span>
              )}
              {row.authors.length > 0 && <span>by {row.authors.join(", ")}</span>}
              {row.downloads != null && (
                <span>
                  <span className="codicon codicon-cloud-download" /> {formatDownloads(row.downloads)}
                </span>
              )}
            </div>
          </div>
          {row.rightLabel && <div className="pkg-row-right">{row.rightLabel}</div>}
        </div>
      ))}
      {loading && visibleRows.length > 0 && <div className="loading">Loading…</div>}
      {hasMore && !loading && (
        <button className="load-more" onClick={onLoadMore}>
          Load more
        </button>
      )}
    </div>
  );
}
