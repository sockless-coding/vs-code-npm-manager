/**
 * Discovers `package.json` files beneath the host's workspace roots and keeps a
 * live model of them, including npm/yarn/pnpm workspace membership.
 *
 * All host-specific I/O (file globbing, change watching, which root owns a file)
 * goes through {@link HostServices}; nothing here imports a specific editor API.
 */

import * as fs from "fs";
import * as path from "path";
import { ProjectInfo } from "@npm-manager/shared";
import { Disposable, HostServices } from "../host";
import { Emitter, debounce } from "../util";
import { parsePackageJson, ParsedPackageJson } from "./packageJson";
import { detectPackageManager, PackageManagerName } from "../node/cli";

const PACKAGE_JSON_GLOB = "**/package.json";
const EXCLUDE_GLOB = "**/node_modules/**";
const WATCH_GLOB = "**/{package.json,package-lock.json,yarn.lock,pnpm-lock.yaml}";

export interface WorkspaceProject {
  info: ProjectInfo;
  parsed: ParsedPackageJson;
  dir: string;
  /** The workspace root that contains this project (or this project's own dir, for a loose file). */
  workspaceRootDir: string;
  packageManager: PackageManagerName;
}

export class ProjectRegistry {
  private projects: WorkspaceProject[] = [];
  private watch?: Disposable;
  private readonly _onDidChange = new Emitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly host: HostServices) {}

  dispose(): void {
    this.watch?.dispose();
    this._onDidChange.dispose();
  }

  start(): void {
    const refresh = debounce(() => void this.refresh(), 400);
    this.watch = this.host.watchFiles(WATCH_GLOB, refresh);
  }

  getProjects(): WorkspaceProject[] {
    return this.projects;
  }

  findByPath(projectPath: string): WorkspaceProject | undefined {
    const norm = path.resolve(projectPath).toLowerCase();
    return this.projects.find((p) => path.resolve(p.info.path).toLowerCase() === norm);
  }

  /**
   * Given the `package.json` the manager was opened from, return the set of
   * package.json paths that entry point governs: itself, plus every workspace
   * member when opened from a workspace root. Empty means "no specific scope".
   */
  resolveSelectionScope(packageJsonPath: string | undefined): string[] {
    if (!packageJsonPath) return [];
    const target = path.resolve(packageJsonPath);
    const project = this.findByPath(target);
    if (!project) return [];
    if (project.info.isWorkspaceRoot) {
      const members = this.projects
        .filter(
          (p) => p.info.workspaceRoot && path.resolve(p.info.workspaceRoot).toLowerCase() === target.toLowerCase()
        )
        .map((p) => p.info.path);
      return [project.info.path, ...members];
    }
    return [project.info.path];
  }

  async refresh(): Promise<void> {
    const files = await this.host.findFiles(PACKAGE_JSON_GLOB, EXCLUDE_GLOB);
    const roots = this.host.getWorkspaceRoots().map((r) => path.resolve(r));
    const entries: { filePath: string; dir: string; parsed: ParsedPackageJson; workspaceRootDir: string }[] = [];

    for (const filePath of files) {
      let text: string;
      try {
        text = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      const parsed = parsePackageJson(text);
      entries.push({
        filePath,
        dir: path.dirname(filePath),
        parsed,
        workspaceRootDir: owningRoot(filePath, roots) ?? path.dirname(filePath)
      });
    }

    const workspaceRoots = entries.filter((e) => e.parsed.workspaces && e.parsed.workspaces.length > 0);
    const memberToRoot = new Map<string, string>();
    for (const root of workspaceRoots) {
      for (const pattern of root.parsed.workspaces ?? []) {
        const matches = await this.host.findFiles(joinGlob(pattern, "package.json"), EXCLUDE_GLOB);
        for (const m of matches) {
          const resolved = path.resolve(m);
          if (resolved === path.resolve(root.filePath)) continue;
          // The glob is not root-anchored by the host, so keep only matches that
          // actually live under this workspace root's directory.
          if (!isUnder(resolved, root.dir)) continue;
          memberToRoot.set(resolved.toLowerCase(), root.filePath);
        }
      }
    }

    const next: WorkspaceProject[] = entries.map((e) => {
      const workspaceRoot = memberToRoot.get(path.resolve(e.filePath).toLowerCase());
      const isWorkspaceRoot = !!e.parsed.workspaces && e.parsed.workspaces.length > 0;
      const packageManager = detectPackageManager(e.dir, e.workspaceRootDir);
      return {
        info: {
          path: e.filePath,
          name: e.parsed.name || path.basename(e.dir),
          workspaceRoot,
          packageManager,
          isWorkspaceRoot
        },
        parsed: e.parsed,
        dir: e.dir,
        workspaceRootDir: e.workspaceRootDir,
        packageManager
      };
    });

    next.sort((a, b) => a.info.name.localeCompare(b.info.name));
    this.projects = next;
    this._onDidChange.fire();
  }
}

/** The workspace root directory that contains `filePath`, if any. */
function owningRoot(filePath: string, roots: string[]): string | undefined {
  const resolved = path.resolve(filePath);
  let best: string | undefined;
  for (const root of roots) {
    if (isUnder(resolved, root) && (!best || root.length > best.length)) best = root;
  }
  return best;
}

function isUnder(child: string, parentDir: string): boolean {
  const rel = path.relative(path.resolve(parentDir), path.resolve(child));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Join a workspace glob pattern (`packages/*`, `apps/**`) with a trailing filename. */
function joinGlob(pattern: string, filename: string): string {
  const trimmed = pattern.replace(/\/+$/, "");
  return `${trimmed}/${filename}`;
}
