/**
 * Discovers `package.json` files in the workspace and keeps a live model of them,
 * including npm/yarn/pnpm workspace membership.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { EventEmitter } from "vscode";
import { ProjectInfo } from "../panel/messaging";
import { parsePackageJson, ParsedPackageJson } from "./packageJson";
import { detectPackageManager, PackageManagerName } from "../node/cli";

const PACKAGE_JSON_GLOB = "**/package.json";
const EXCLUDE_GLOB = "**/node_modules/**";

export interface WorkspaceProject {
  info: ProjectInfo;
  parsed: ParsedPackageJson;
  dir: string;
  /** The containing VS Code workspace folder (or this project's own dir, for a loose file). */
  workspaceRootDir: string;
  packageManager: PackageManagerName;
}

export class ProjectRegistry implements vscode.Disposable {
  private projects: WorkspaceProject[] = [];
  private watcher?: vscode.FileSystemWatcher;
  private readonly _onDidChange = new EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  dispose(): void {
    this.watcher?.dispose();
    this._onDidChange.dispose();
  }

  start(): void {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      "**/{package.json,package-lock.json,yarn.lock,pnpm-lock.yaml}",
      false,
      false,
      false
    );
    const refresh = debounce(() => this.refresh(), 400);
    this.watcher.onDidChange(refresh);
    this.watcher.onDidCreate(refresh);
    this.watcher.onDidDelete(refresh);
  }

  getProjects(): WorkspaceProject[] {
    return this.projects;
  }

  findByPath(projectPath: string): WorkspaceProject | undefined {
    const norm = path.resolve(projectPath).toLowerCase();
    return this.projects.find((p) => path.resolve(p.info.path).toLowerCase() === norm);
  }

  /**
   * Given the file the manager was opened from (a `package.json`), return the set
   * of package.json paths that entry point governs: itself, plus every workspace
   * member when opened from a workspace root. Empty means "no specific scope".
   */
  resolveSelectionScope(uri: vscode.Uri | undefined): string[] {
    if (!uri) return [];
    const target = path.resolve(uri.fsPath);
    const project = this.findByPath(target);
    if (!project) return [];
    if (project.info.isWorkspaceRoot) {
      const members = this.projects
        .filter((p) => p.info.workspaceRoot && path.resolve(p.info.workspaceRoot).toLowerCase() === target.toLowerCase())
        .map((p) => p.info.path);
      return [project.info.path, ...members];
    }
    return [project.info.path];
  }

  async refresh(): Promise<void> {
    const uris = await vscode.workspace.findFiles(PACKAGE_JSON_GLOB, EXCLUDE_GLOB);
    const entries: { filePath: string; dir: string; parsed: ParsedPackageJson; workspaceRootDir: string }[] = [];

    for (const uri of uris) {
      const filePath = uri.fsPath;
      let text: string;
      try {
        text = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      const parsed = parsePackageJson(text);
      const workspaceRootDir = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? path.dirname(filePath);
      entries.push({ filePath, dir: path.dirname(filePath), parsed, workspaceRootDir });
    }

    const roots = entries.filter((e) => e.parsed.workspaces && e.parsed.workspaces.length > 0);
    const memberToRoot = new Map<string, string>();
    for (const root of roots) {
      for (const pattern of root.parsed.workspaces ?? []) {
        const matches = await vscode.workspace.findFiles(
          new vscode.RelativePattern(root.dir, joinGlob(pattern, "package.json")),
          EXCLUDE_GLOB
        );
        for (const m of matches) {
          if (m.fsPath !== root.filePath) memberToRoot.set(path.resolve(m.fsPath).toLowerCase(), root.filePath);
        }
      }
    }

    const next: WorkspaceProject[] = entries.map((e) => {
      const workspaceRoot = memberToRoot.get(path.resolve(e.filePath).toLowerCase());
      const isWorkspaceRoot = !!e.parsed.workspaces && e.parsed.workspaces.length > 0;
      return {
        info: {
          path: e.filePath,
          name: e.parsed.name || path.basename(e.dir),
          workspaceRoot,
          packageManager: detectPackageManager(e.dir, e.workspaceRootDir),
          isWorkspaceRoot
        },
        parsed: e.parsed,
        dir: e.dir,
        workspaceRootDir: e.workspaceRootDir,
        packageManager: detectPackageManager(e.dir, e.workspaceRootDir)
      };
    });

    next.sort((a, b) => a.info.name.localeCompare(b.info.name));
    this.projects = next;
    this._onDidChange.fire();
  }
}

/** Join a workspace glob pattern (`packages/*`, `apps/**`) with a trailing filename. */
function joinGlob(pattern: string, filename: string): string {
  const trimmed = pattern.replace(/\/+$/, "");
  return `${trimmed}/${filename}`;
}

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let handle: NodeJS.Timeout | undefined;
  return ((...args: any[]) => {
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => fn(...args), ms);
  }) as T;
}
