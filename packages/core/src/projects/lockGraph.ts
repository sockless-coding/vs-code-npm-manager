/**
 * Reads the resolved dependency graph for a workspace root, preferring the
 * lockfile (authoritative, fast, one read for the whole repo) and falling back
 * to a shallow `node_modules` scan when no lockfile has been committed yet.
 *
 * Only `package-lock.json` (npm v2/v3) is parsed in full; `yarn.lock` and
 * `pnpm-lock.yaml` repos fall back to the `node_modules` scan, which is enough
 * to resolve versions and top-level edges without a YAML/custom-format parser.
 */

import * as fs from "fs";
import * as path from "path";

export interface DependencyGraph {
  /** idLower -> ids it depends on directly (idLower). */
  dependencies: Map<string, Set<string>>;
  /** idLower -> ids that depend on it directly (idLower). */
  dependents: Map<string, Set<string>>;
  /** idLower -> resolved version. */
  resolved: Map<string, string>;
  /** idLower -> original casing (npm ids are already lower-case except scopes, kept for symmetry). */
  displayName: Map<string, string>;
}

function emptyGraph(): DependencyGraph {
  return { dependencies: new Map(), dependents: new Map(), resolved: new Map(), displayName: new Map() };
}

function setInMap(map: Map<string, Set<string>>, key: string): Set<string> {
  const s = new Set<string>();
  map.set(key, s);
  return s;
}

function note(graph: DependencyGraph, id: string): void {
  const key = id.toLowerCase();
  if (!graph.displayName.has(key)) graph.displayName.set(key, id);
}

function addEdge(graph: DependencyGraph, parent: string, child: string): void {
  const p = parent.toLowerCase();
  const c = child.toLowerCase();
  if (p === c) return;
  (graph.dependencies.get(p) ?? setInMap(graph.dependencies, p)).add(c);
  (graph.dependents.get(c) ?? setInMap(graph.dependents, c)).add(p);
}

/** `node_modules/foo` -> `foo`; `node_modules/@scope/foo` -> `@scope/foo`; nested paths take the last segment pair. */
function nameFromPackagePath(pkgPath: string): string | undefined {
  const segments = pkgPath.split("node_modules/").filter(Boolean);
  const last = segments[segments.length - 1];
  return last ? last.replace(/\/$/, "") : undefined;
}

/** Parse an npm `package-lock.json` (lockfileVersion 2 or 3, using the flat `packages` map). */
export function buildGraphFromNpmLockfile(lockJson: unknown): DependencyGraph {
  const graph = emptyGraph();
  if (!lockJson || typeof lockJson !== "object") return graph;
  const doc = lockJson as Record<string, any>;
  const packages = doc.packages;
  if (!packages || typeof packages !== "object") return graph;

  for (const [pkgPath, entry] of Object.entries<any>(packages)) {
    if (pkgPath === "" || !entry || typeof entry !== "object") continue;
    const name = nameFromPackagePath(pkgPath);
    if (!name) continue;
    note(graph, name);
    const key = name.toLowerCase();
    if (entry.version && !graph.resolved.has(key)) {
      graph.resolved.set(key, String(entry.version));
    }
    const deps = { ...(entry.dependencies ?? {}), ...(entry.peerDependencies ?? {}), ...(entry.optionalDependencies ?? {}) };
    for (const childId of Object.keys(deps)) {
      note(graph, childId);
      addEdge(graph, name, childId);
    }
  }

  return graph;
}

/** Shallow `node_modules` scan: top-level packages only (no nested-conflict resolution). */
function buildGraphFromNodeModules(rootDir: string): DependencyGraph {
  const graph = emptyGraph();
  const nodeModules = path.join(rootDir, "node_modules");
  const names = listPackageNames(nodeModules);

  for (const name of names) {
    const pkgJsonPath = path.join(nodeModules, ...name.split("/"), "package.json");
    let manifest: any;
    try {
      manifest = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    } catch {
      continue;
    }
    note(graph, name);
    const key = name.toLowerCase();
    if (manifest.version) graph.resolved.set(key, String(manifest.version));
    const deps = { ...(manifest.dependencies ?? {}), ...(manifest.peerDependencies ?? {}), ...(manifest.optionalDependencies ?? {}) };
    for (const childId of Object.keys(deps)) {
      note(graph, childId);
      addEdge(graph, name, childId);
    }
  }

  return graph;
}

function listPackageNames(nodeModulesDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    if (e.name.startsWith("@")) {
      let scoped: fs.Dirent[];
      try {
        scoped = fs.readdirSync(path.join(nodeModulesDir, e.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of scoped) {
        if (s.isDirectory()) names.push(`${e.name}/${s.name}`);
      }
    } else {
      names.push(e.name);
    }
  }
  return names;
}

/** Directory (at or above `startDir`, not above `stopDir`) containing a lockfile, or `undefined`. */
export function findLockfileRoot(startDir: string, stopDir: string): { dir: string; kind: "npm" | "yarn" | "pnpm" } | undefined {
  let dir = startDir;
  for (;;) {
    if (fileExists(path.join(dir, "package-lock.json"))) return { dir, kind: "npm" };
    if (fileExists(path.join(dir, "yarn.lock"))) return { dir, kind: "yarn" };
    if (fileExists(path.join(dir, "pnpm-lock.yaml"))) return { dir, kind: "pnpm" };
    if (dir === stopDir || dir === path.dirname(dir)) break;
    dir = path.dirname(dir);
  }
  return undefined;
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Best-effort resolved graph for a project: its workspace's lockfile, or a `node_modules` scan. */
export function readDependencyGraph(projectDir: string, workspaceRootDir: string): DependencyGraph {
  const lock = findLockfileRoot(projectDir, workspaceRootDir);
  if (lock?.kind === "npm") {
    try {
      const raw = fs.readFileSync(path.join(lock.dir, "package-lock.json"), "utf8");
      return buildGraphFromNpmLockfile(JSON.parse(raw));
    } catch {
      /* fall through to node_modules scan */
    }
  }
  const scanRoot = lock?.dir ?? workspaceRootDir;
  return buildGraphFromNodeModules(scanRoot);
}

export function mergeGraphs(graphs: DependencyGraph[]): DependencyGraph {
  const merged = emptyGraph();
  for (const g of graphs) {
    for (const [k, v] of g.displayName) if (!merged.displayName.has(k)) merged.displayName.set(k, v);
    for (const [k, v] of g.resolved) if (!merged.resolved.has(k)) merged.resolved.set(k, v);
    for (const [k, set] of g.dependencies) {
      const into = merged.dependencies.get(k) ?? setInMap(merged.dependencies, k);
      for (const c of set) into.add(c);
    }
    for (const [k, set] of g.dependents) {
      const into = merged.dependents.get(k) ?? setInMap(merged.dependents, k);
      for (const c of set) into.add(c);
    }
  }
  return merged;
}
