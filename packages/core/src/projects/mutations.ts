/**
 * Applying install / update / uninstall / pin / unpin.
 *
 * Install and update carry a {@link VersionPrefix} — caret, tilde, exact, or
 * ">=" — describing how the chosen version should be written. Only "caret"
 * (a CLI's own default) and "exact" (`--save-exact`) map onto an actual CLI
 * flag; a tilde or ">=" range, pin/unpin (a pure version-string rewrite the
 * CLIs would normalize away), and any case where the package manager isn't
 * available all fall back to a format-preserving `package.json` edit via
 * `jsonEdit`, which reports `installNeeded` so the lockfile can be refreshed
 * afterwards.
 *
 * Otherwise: `npm install`/`yarn add`/`pnpm add` (or the `remove` equivalent)
 * per project, then an install in each touched directory (when
 * `npmManager.autoInstall` is on) to refresh the lockfile and `node_modules`.
 */

import * as fs from "fs";
import {
  DependencyType,
  MutationRequest,
  MutationResult,
  VersionPrefix,
  applyVersionPrefix,
  detectVersionPrefix,
  toCaretRange,
  toExactVersionPin
} from "@npm-manager/shared";
import { HostServices } from "../host";
import { PackageManagerCli } from "../node/cli";
import { ProjectRegistry, WorkspaceProject } from "./discovery";
import { projectDisplayName } from "./installed";
import { removeDependency, upsertDependency } from "./jsonEdit";

export class MutationService {
  constructor(
    private readonly host: HostServices,
    private readonly projects: ProjectRegistry,
    private readonly cli: PackageManagerCli
  ) {}

  async apply(req: MutationRequest, registryUrl?: string): Promise<MutationResult> {
    const result: MutationResult = {
      ok: true,
      action: req.action,
      packageId: req.packageId,
      perProject: [],
      usedFallback: false,
      installNeeded: false
    };
    const touchedDirs = new Map<string, WorkspaceProject>();

    for (const projectPath of req.projectPaths) {
      const project = this.projects.findByPath(projectPath);
      if (!project) {
        result.perProject.push({ project: projectDisplayName(projectPath), ok: false, message: "package.json not found" });
        result.ok = false;
        continue;
      }
      const pmAvailable = await this.cli.isAvailable(project.packageManager);
      try {
        if (req.action === "pin" || req.action === "unpin") {
          this.applyPin(req, project, req.action);
          result.usedFallback = true;
        } else if (req.action === "uninstall") {
          if (pmAvailable) {
            await this.applyRemoveWithCli(req, project);
          } else {
            this.applyRemoveWithJson(req, project);
            result.usedFallback = true;
          }
        } else {
          const dependencyType =
            req.action === "update" ? this.currentType(project, req.packageId) : req.dependencyType ?? "dependencies";
          const prefix = this.resolvePrefix(req, project);
          // Only "exact" (--save-exact) and "caret" (each CLI's own default) map
          // onto an actual flag; a tilde or ">=" range has to be written by hand.
          const canUseCli =
            pmAvailable &&
            (prefix === "exact" || prefix === "caret") &&
            this.cli.supportsAddType(project.packageManager, dependencyType);
          if (canUseCli) {
            await this.applyAddWithCli(req, project, dependencyType, prefix === "exact", registryUrl);
          } else {
            this.applyAddWithJson(req, project, dependencyType, prefix);
            result.usedFallback = true;
          }
        }
        touchedDirs.set(project.dir, project);
        result.perProject.push({ project: project.info.name, ok: true });
      } catch (err: any) {
        result.ok = false;
        result.perProject.push({ project: project.info.name, ok: false, message: err?.message ?? String(err) });
      }
    }

    if (result.ok && this.host.getConfig<boolean>("autoInstall", true)) {
      for (const project of touchedDirs.values()) {
        if (!(await this.cli.isAvailable(project.packageManager))) {
          result.installNeeded = true;
          continue;
        }
        const r = await this.cli.install(project.packageManager, project.dir);
        if (r.code !== 0) result.installNeeded = true;
      }
    } else if (result.ok) {
      result.installNeeded = true;
    }

    await this.projects.refresh();
    return result;
  }

  private async applyRemoveWithCli(req: MutationRequest, project: WorkspaceProject): Promise<void> {
    const r = await this.cli.removePackage(project.packageManager, project.dir, req.packageId);
    if (r.code !== 0) throw new Error(lastLine(r.stderr || r.stdout) || `${project.packageManager} remove failed`);
  }

  private async applyAddWithCli(
    req: MutationRequest,
    project: WorkspaceProject,
    dependencyType: DependencyType,
    exact: boolean,
    registryUrl?: string
  ): Promise<void> {
    const r = await this.cli.addPackage(
      project.packageManager,
      project.dir,
      req.packageId,
      req.version,
      dependencyType,
      exact,
      registryUrl
    );
    if (r.code !== 0) throw new Error(lastLine(r.stderr || r.stdout) || `${project.packageManager} add failed`);
  }

  private applyRemoveWithJson(req: MutationRequest, project: WorkspaceProject): void {
    this.host.log(`[json] uninstall ${req.packageId} in ${project.info.name}`);
    editFile(project.info.path, (t) => removeDependency(t, req.packageId));
  }

  private applyAddWithJson(req: MutationRequest, project: WorkspaceProject, dependencyType: DependencyType, prefix: VersionPrefix): void {
    if (!req.version) throw new Error("A target version is required");
    const range = applyVersionPrefix(req.version, prefix);
    this.host.log(`[json] ${req.action} ${req.packageId}@${range} in ${project.info.name}`);
    editFile(project.info.path, (t) => upsertDependency(t, req.packageId, range, dependencyType));
  }

  private currentType(project: WorkspaceProject, packageId: string): DependencyType {
    const key = packageId.toLowerCase();
    return project.parsed.dependencies.find((r) => r.id.toLowerCase() === key)?.dependencyType ?? "dependencies";
  }

  /**
   * The version selector to write: whatever the caller explicitly chose, else the
   * selector the project's current reference already uses (so an unrelated Update
   * doesn't silently change a package's range style), else "caret" for a fresh install.
   */
  private resolvePrefix(req: MutationRequest, project: WorkspaceProject): VersionPrefix {
    if (req.versionPrefix) return req.versionPrefix;
    if (req.action === "update") {
      const key = req.packageId.toLowerCase();
      const ref = project.parsed.dependencies.find((r) => r.id.toLowerCase() === key);
      if (ref) return detectVersionPrefix(ref.version);
    }
    return "caret";
  }

  /** Write the version as a bare exact version (pin) or a caret range (unpin), preserving file formatting. */
  private applyPin(req: MutationRequest, project: WorkspaceProject, mode: "pin" | "unpin"): void {
    if (!req.version) throw new Error("A target version is required");
    const version = mode === "pin" ? toExactVersionPin(req.version) : toCaretRange(req.version);
    const dependencyType = this.currentType(project, req.packageId);
    this.host.log(`[json] ${mode} ${req.packageId}@${version} in ${project.info.name}`);
    editFile(project.info.path, (t) => upsertDependency(t, req.packageId, version, dependencyType));
  }
}

function editFile(filePath: string, transform: (text: string) => string): void {
  const original = fs.readFileSync(filePath, "utf8");
  const updated = transform(original);
  if (updated !== original) {
    fs.writeFileSync(filePath, updated, "utf8");
  }
}

function lastLine(s: string): string {
  const lines = s.split(/\r\n|\n|\r/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}
