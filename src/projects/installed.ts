/**
 * Builds the "Installed" view and its update / vulnerability enrichment.
 *
 * The list is produced in two phases so a large repo paints immediately:
 *
 *  1. A local snapshot, read entirely from disk with no CLI invocation: the four
 *     dependency sections of each `package.json` for requested versions, and the
 *     workspace's lockfile (or a `node_modules` scan when there is none yet) for
 *     the resolved dependency graph, resolved versions and transitive classification.
 *
 *  2. Background enrichment: the latest available version, publish date and
 *     deprecation flag for each direct package (registry queries, concurrency
 *     limited), plus `npm audit --json` for known advisories — npm's lockfile
 *     carries no offline advisory data of its own, unlike a NuGet restore.
 *     Progress and partial results are streamed to the webview through the
 *     {@link InstalledNotifier}.
 *
 * Setting `npmManager.usePackageManagerForEnumeration` additionally reconciles the
 * snapshot with `npm outdated --json` during enrichment, for npm projects that
 * need npm's own resolution semantics (dist-tags, engines).
 */

import * as path from "path";
import * as vscode from "vscode";
import { InstalledPackage } from "../panel/messaging";
import { PackageManagerCli, NpmAuditAdvisory } from "../node/cli";
import { ProjectRegistry, WorkspaceProject } from "./discovery";
import { RegistryRegistry } from "../npm/registries";
import { MetadataService } from "../npm/metadata";
import { maxVersion } from "../npm/semverUtil";
import { isExactVersionPin, stripVersionPin } from "../npm/versionRange";
import { DependencyGraph, findLockfileRoot, mergeGraphs, readDependencyGraph } from "./lockGraph";
import { mapWithConcurrency } from "../util";

const DAY_MS = 24 * 60 * 60 * 1000;
const SEVERITY_WORDS: Record<string, number> = { info: 0, low: 0, moderate: 1, high: 2, critical: 3 };

/** How the extension host is told about streamed enrichment progress and results. */
export interface InstalledNotifier {
  /** A short status line for the webview banner. `done` clears it. */
  progress(message: string, done: boolean): void;
  /** A fresh copy of the installed list, filtered for the current view. */
  enriched(phase: "updates" | "vulnerabilities" | "done", packages: InstalledPackage[]): void;
}

export class InstalledService {
  /** The full unfiltered snapshot (direct + transitive), shared by every consumer. */
  private snapshot: InstalledPackage[] | undefined;
  private snapshotPromise: Promise<InstalledPackage[]> | undefined;
  /** Bumped whenever the on-disk model changes; stale async work checks against it. */
  private runToken = 0;
  private enrichPromise: Promise<void> | undefined;
  private enrichToken = -1;
  /** The `includeTransitive` value of the last `list()` call, for enriched pushes. */
  private lastIncludeTransitive = false;

  constructor(
    private readonly projects: ProjectRegistry,
    private readonly cli: PackageManagerCli,
    private readonly registries: RegistryRegistry,
    private readonly metadata: MetadataService,
    private readonly notify: InstalledNotifier
  ) {}

  /** Drop cached results; the next `list()` rebuilds from disk. */
  invalidate(): void {
    this.runToken++;
    this.snapshot = undefined;
    this.snapshotPromise = undefined;
    this.enrichPromise = undefined;
  }

  async list(includeTransitive: boolean): Promise<{ packages: InstalledPackage[]; packageManagerAvailable: boolean }> {
    this.lastIncludeTransitive = includeTransitive;
    const snap = await this.ensureSnapshot();
    void this.ensureEnrichment();
    return {
      packages: this.filterForView(snap, includeTransitive),
      packageManagerAvailable: await this.cli.isAvailable("npm")
    };
  }

  /* --------------------------- phase 1: snapshot --------------------------- */

  private ensureSnapshot(): Promise<InstalledPackage[]> {
    if (this.snapshot) return Promise.resolve(this.snapshot);
    if (!this.snapshotPromise) {
      const token = this.runToken;
      this.snapshotPromise = this.buildLocalSnapshot().then((snap) => {
        if (token === this.runToken) this.snapshot = snap;
        this.snapshotPromise = undefined;
        return this.snapshot ?? snap;
      });
    }
    return this.snapshotPromise;
  }

  private async buildLocalSnapshot(): Promise<InstalledPackage[]> {
    const projects = this.projects.getProjects();
    const merged = new Map<string, InstalledPackage>();

    // Requested versions + per-project direct references from each package.json.
    for (const project of projects) this.foldProjectModel(project, merged);

    // Resolved dependency graph — one lockfile (or node_modules scan) per distinct
    // workspace root, shared by every project that root contains.
    const graphByRoot = new Map<string, DependencyGraph>();
    for (const project of projects) {
      const rootKey = (findLockfileRoot(project.dir, project.workspaceRootDir)?.dir ?? project.workspaceRootDir).toLowerCase();
      if (!graphByRoot.has(rootKey)) {
        graphByRoot.set(rootKey, readDependencyGraph(project.dir, project.workspaceRootDir));
      }
    }
    const graph = mergeGraphs([...graphByRoot.values()]);

    // Add packages that appear only in the resolved graph (transitive).
    for (const [key, display] of graph.displayName) {
      if (merged.has(key)) continue;
      if (!graph.resolved.has(key)) continue;
      merged.set(key, { id: display, requestedVersion: "", projects: [], projectVersions: [], transitive: true });
    }

    for (const [key, entry] of merged) {
      if (entry.projectVersions.length > 0) entry.transitive = false;
      else entry.transitive = true;

      const resolved = graph.resolved.get(key);
      if (resolved) entry.resolvedVersion = resolved;

      applyGraphEdges(entry, key, graph);
    }

    this.markPinned(merged);

    return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  private filterForView(snapshot: InstalledPackage[], includeTransitive: boolean): InstalledPackage[] {
    return snapshot
      .filter((p) => includeTransitive || !p.transitive || p.hasVulnerability)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /* -------------------------- phase 2: enrichment ------------------------- */

  private ensureEnrichment(): Promise<void> {
    if (this.enrichPromise && this.enrichToken === this.runToken) return this.enrichPromise;
    const token = this.runToken;
    this.enrichToken = token;
    this.enrichPromise = this.runEnrichment(token)
      .catch(() => {
        /* enrichment is best-effort */
      })
      .finally(() => {
        if (this.enrichToken === token) this.notify.progress("", true);
      });
    return this.enrichPromise;
  }

  private async runEnrichment(token: number): Promise<void> {
    const snap = await this.ensureSnapshot();
    if (token !== this.runToken) return;

    const direct = snap.filter((p) => !p.transitive);
    const includePrerelease = vscode.workspace
      .getConfiguration("npmManager")
      .get<boolean>("defaultIncludePrerelease", false);
    const minAgeDays = this.minimumPackageAgeDays();

    if (this.registries.getEnabledRegistries().length > 0 && direct.length > 0) {
      const total = direct.length;
      let done = 0;
      let lastPush = 0;
      this.notify.progress(`Checking ${total} package${total === 1 ? "" : "s"} for updates…`, false);
      await mapWithConcurrency(direct, 12, async (pkg) => {
        if (token !== this.runToken) return;
        await this.enrichPackage(pkg, includePrerelease, minAgeDays);
        done++;
        this.notify.progress(`Checking ${total} packages for updates… (${done}/${total})`, false);
        if (Date.now() - lastPush > 400) {
          lastPush = Date.now();
          this.pushEnriched("updates");
        }
      });
      if (token !== this.runToken) return;
      this.pushEnriched("updates");
    }

    this.notify.progress("Checking for known vulnerabilities…", false);
    await this.applyAudits(snap, token);
    if (token !== this.runToken) return;
    this.pushEnriched("vulnerabilities");

    if (this.usePackageManagerForEnumeration()) {
      await this.reconcileWithNpm(snap, token);
      if (token !== this.runToken) return;
    }

    this.pushEnriched("done");
  }

  private pushEnriched(phase: "updates" | "vulnerabilities" | "done"): void {
    if (!this.snapshot) return;
    this.notify.enriched(phase, this.filterForView(this.snapshot, this.lastIncludeTransitive));
  }

  private async enrichPackage(pkg: InstalledPackage, includePrerelease: boolean, minAgeDays: number): Promise<void> {
    const registry = this.registries.registryForPackage(pkg.id);
    const candidates = registry
      ? [registry, ...this.registries.getEnabledRegistries().filter((r) => r !== registry)]
      : this.registries.getEnabledRegistries();

    for (const r of candidates) {
      try {
        const doc = await this.metadata.getDocument(r.url, pkg.id);
        const versions = Object.keys(doc.versions ?? {});
        const latest = maxVersion(versions, includePrerelease) ?? doc["dist-tags"]?.latest;
        if (latest) {
          pkg.latestVersion = latest;
          pkg.latestPublished = doc.time?.[latest];
          if (pkg.latestPublished && minAgeDays > 0) {
            const ageDays = (Date.now() - Date.parse(pkg.latestPublished)) / DAY_MS;
            pkg.latestBelowMinAge = Number.isFinite(ageDays) && ageDays < minAgeDays;
          }
        }
        const installedVersion = cleanVersion(pkg.resolvedVersion || pkg.requestedVersion || "");
        if (installedVersion && doc.versions?.[installedVersion]?.deprecated) {
          pkg.deprecated = true;
        }
        return;
      } catch {
        /* try the next registry */
      }
    }
  }

  /** Run `npm audit --json` once per distinct npm-managed lockfile root and fold advisories in. */
  private async applyAudits(snap: InstalledPackage[], token: number): Promise<void> {
    const byId = new Map(snap.map((p) => [p.id.toLowerCase(), p]));
    const roots = new Map<string, { dir: string; projectPaths: string[] }>();
    for (const project of this.projects.getProjects()) {
      if (project.packageManager !== "npm") continue;
      const dir = findLockfileRoot(project.dir, project.workspaceRootDir)?.dir;
      if (!dir) continue;
      const key = dir.toLowerCase();
      const bucket = roots.get(key) ?? { dir, projectPaths: [] };
      bucket.projectPaths.push(project.info.path);
      roots.set(key, bucket);
    }
    if (roots.size === 0 || !(await this.cli.isAvailable("npm"))) return;

    for (const { dir, projectPaths } of roots.values()) {
      if (token !== this.runToken) return;
      const result = await this.cli.audit(dir);
      if (!result?.vulnerabilities) continue;
      for (const [name, advisory] of Object.entries(result.vulnerabilities)) {
        const entry = byId.get(name.toLowerCase());
        if (!entry) continue;
        this.applyAdvisory(entry, advisory);
        for (const p of projectPaths) this.markVulnerableProject(entry, p);
      }
    }
  }

  /** Opt-in: fold `npm outdated --json` over the snapshot for npm-managed roots. */
  private async reconcileWithNpm(snap: InstalledPackage[], token: number): Promise<void> {
    if (!(await this.cli.isAvailable("npm"))) return;
    const byId = new Map(snap.map((p) => [p.id.toLowerCase(), p]));
    const roots = new Set<string>();
    for (const project of this.projects.getProjects()) {
      if (project.packageManager !== "npm") continue;
      const root = findLockfileRoot(project.dir, project.workspaceRootDir)?.dir ?? project.dir;
      roots.add(root);
    }
    this.notify.progress("Reconciling with npm…", false);
    for (const root of roots) {
      if (token !== this.runToken) return;
      const outdated = await this.cli.outdated(root);
      if (!outdated) continue;
      for (const [name, entry] of Object.entries(outdated)) {
        const pkg = byId.get(name.toLowerCase());
        if (pkg && entry.latest) pkg.latestVersion = entry.latest;
      }
    }
  }

  /* ------------------------------ folding -------------------------------- */

  private foldProjectModel(project: WorkspaceProject, merged: Map<string, InstalledPackage>): void {
    for (const ref of project.parsed.dependencies) {
      const key = ref.id.toLowerCase();
      const existing = merged.get(key);
      const entry: InstalledPackage = existing ?? {
        id: ref.id,
        requestedVersion: ref.version,
        projects: [],
        projectVersions: [],
        transitive: false
      };
      if (!existing) merged.set(key, entry);
      entry.transitive = false;
      if (ref.version && !entry.requestedVersion) entry.requestedVersion = ref.version;
      if (!entry.projects.includes(project.info.path)) entry.projects.push(project.info.path);
      if (!entry.projectVersions.some((pv) => pv.project === project.info.path)) {
        entry.projectVersions.push({ project: project.info.path, version: ref.version, dependencyType: ref.dependencyType });
      }
    }
  }

  private markPinned(merged: Map<string, InstalledPackage>): void {
    for (const entry of merged.values()) {
      for (const pv of entry.projectVersions) pv.pinned = isExactVersionPin(pv.version);
      const direct = entry.projectVersions;
      entry.pinned = direct.length > 0 && direct.every((pv) => pv.pinned);
      if (entry.pinned) {
        const versions = new Set(direct.map((pv) => stripVersionPin(pv.version)));
        entry.pinnedVersion = versions.size === 1 ? [...versions][0] : undefined;
      }
    }
  }

  private markVulnerableProject(entry: InstalledPackage, projectPath: string): void {
    entry.vulnerableProjects ??= [];
    if (!entry.vulnerableProjects.includes(projectPath)) entry.vulnerableProjects.push(projectPath);
    if (!entry.projects.includes(projectPath)) entry.projects.push(projectPath);
  }

  private applyAdvisory(entry: InstalledPackage, advisory: NpmAuditAdvisory): void {
    const severity = SEVERITY_WORDS[advisory.severity] ?? 0;
    const urls = advisory.via
      .filter((v): v is { title?: string; url?: string } => typeof v === "object")
      .map((v) => v.url)
      .filter((u): u is string => !!u);
    const list = entry.vulnerabilities ?? [];
    for (const url of urls.length > 0 ? urls : [""]) {
      if (!list.some((x) => x.advisoryUrl === url && x.severity === severity)) {
        list.push({ severity, advisoryUrl: url });
      }
    }
    entry.vulnerabilities = list;
    entry.hasVulnerability = true;
    entry.maxVulnerabilitySeverity = list.reduce((m, a) => Math.max(m, a.severity), -1);
  }

  private usePackageManagerForEnumeration(): boolean {
    return vscode.workspace.getConfiguration("npmManager").get<boolean>("usePackageManagerForEnumeration", false);
  }

  private minimumPackageAgeDays(): number {
    const raw = vscode.workspace.getConfiguration("npmManager").get<number>("minimumPackageAgeDays", 7);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }
}

function applyGraphEdges(entry: InstalledPackage, key: string, graph: DependencyGraph): void {
  const requiredBy = graph.dependents.get(key);
  if (requiredBy?.size) {
    entry.requiredBy = [...requiredBy].map((k) => graph.displayName.get(k) ?? k).sort((a, b) => a.localeCompare(b));
  }
  const dependsOn = graph.dependencies.get(key);
  if (dependsOn?.size) {
    entry.dependsOn = [...dependsOn].map((k) => graph.displayName.get(k) ?? k).sort((a, b) => a.localeCompare(b));
  }
}

/** `^1.2.3` / `~1.2.3` / `1.2.3` -> `1.2.3` (best-effort first concrete version token). */
function cleanVersion(raw: string): string {
  return raw.replace(/^[\^~=]+/, "").trim();
}

export function projectDisplayName(projectPath: string): string {
  return path.basename(path.dirname(projectPath)) || projectPath;
}
