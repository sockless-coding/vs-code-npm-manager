/**
 * Wrapper around the npm / yarn (classic) / pnpm CLIs. Package mutations and the
 * optional `npm ls` / `npm outdated` / `npm audit` reconciliation go through here
 * when the relevant executable is available.
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { DependencyType } from "../panel/messaging";

export type PackageManagerName = "npm" | "yarn" | "pnpm";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const SAVE_FLAG: Record<DependencyType, string> = {
  dependencies: "--save-prod",
  devDependencies: "--save-dev",
  peerDependencies: "--save-peer",
  optionalDependencies: "--save-optional"
};

/** Dependency types each CLI can add directly; anything else falls back to a JSON edit. */
const SUPPORTED_ADD_TYPES: Record<PackageManagerName, Set<DependencyType>> = {
  npm: new Set(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]),
  pnpm: new Set(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]),
  yarn: new Set(["dependencies", "devDependencies"])
};

/** Detect the package manager for a project directory from its lockfile, walking up to the workspace root. */
export function detectPackageManager(projectDir: string, workspaceRoot: string): PackageManagerName {
  let dir = projectDir;
  for (;;) {
    if (fileExists(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
    if (fileExists(path.join(dir, "yarn.lock"))) return "yarn";
    if (fileExists(path.join(dir, "package-lock.json"))) return "npm";
    if (dir === workspaceRoot || dir === path.dirname(dir)) break;
    dir = path.dirname(dir);
  }
  return "npm";
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export class PackageManagerCli {
  private availability = new Map<PackageManagerName, boolean>();

  constructor(private readonly output: vscode.OutputChannel) {}

  supportsAddType(pm: PackageManagerName, type: DependencyType): boolean {
    return SUPPORTED_ADD_TYPES[pm].has(type);
  }

  private exeFor(pm: PackageManagerName): string {
    const override = vscode.workspace.getConfiguration("npmManager").get<string>("packageManagerPath");
    return override && override.trim() ? override.trim() : pm;
  }

  async isAvailable(pm: PackageManagerName): Promise<boolean> {
    const cached = this.availability.get(pm);
    if (cached !== undefined) return cached;
    let ok: boolean;
    try {
      const r = await this.run(pm, ["--version"], undefined, true);
      ok = r.code === 0;
    } catch {
      ok = false;
    }
    this.availability.set(pm, ok);
    return ok;
  }

  invalidateAvailability(): void {
    this.availability.clear();
  }

  run(pm: PackageManagerName, args: string[], cwd?: string, quiet = false): Promise<RunResult> {
    const workingDir = cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const exe = this.exeFor(pm);
    if (!quiet) {
      this.output.appendLine(`> ${pm} ${args.join(" ")}  (${workingDir})`);
    }
    return new Promise((resolve, reject) => {
      execFile(
        exe,
        args,
        { cwd: workingDir, maxBuffer: 32 * 1024 * 1024, windowsHide: true, shell: process.platform === "win32" },
        (err, stdout, stderr) => {
          if (!quiet) {
            if (stdout) this.output.append(stdout);
            if (stderr) this.output.append(stderr);
          }
          if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
            reject(new Error(`'${exe}' was not found. Install ${pm} or set 'npmManager.packageManagerPath'.`));
            return;
          }
          const code = typeof err?.code === "number" ? err.code : err ? 1 : 0;
          resolve({ code, stdout, stderr });
        }
      );
    });
  }

  async addPackage(
    pm: PackageManagerName,
    projectDir: string,
    id: string,
    version: string | undefined,
    dependencyType: DependencyType,
    exact: boolean,
    registryUrl?: string
  ): Promise<RunResult> {
    const spec = version ? `${id}@${version}` : id;
    if (pm === "npm") {
      const args = ["install", spec, SAVE_FLAG[dependencyType]];
      if (exact) args.push("--save-exact");
      if (registryUrl) args.push("--registry", registryUrl);
      return this.run(pm, args, projectDir);
    }
    if (pm === "pnpm") {
      const args = ["add", spec];
      if (dependencyType === "devDependencies") args.push("--save-dev");
      else if (dependencyType === "peerDependencies") args.push("--save-peer");
      else if (dependencyType === "optionalDependencies") args.push("--save-optional");
      if (exact) args.push("--save-exact");
      if (registryUrl) args.push("--registry", registryUrl);
      return this.run(pm, args, projectDir);
    }
    // yarn classic
    const args = ["add", spec];
    if (dependencyType === "devDependencies") args.push("--dev");
    if (exact) args.push("--exact");
    if (registryUrl) args.push("--registry", registryUrl);
    return this.run(pm, args, projectDir);
  }

  async removePackage(pm: PackageManagerName, projectDir: string, id: string): Promise<RunResult> {
    const verb = pm === "npm" ? "uninstall" : "remove";
    return this.run(pm, [verb, id], projectDir);
  }

  async install(pm: PackageManagerName, projectDir: string): Promise<RunResult> {
    return this.run(pm, ["install"], projectDir);
  }

  /** `npm list --all --json`; `undefined` on any non-JSON failure. Only meaningful for npm. */
  async listPackages(projectDir: string): Promise<NpmListOutput | undefined> {
    const r = await this.run("npm", ["ls", "--all", "--json"], projectDir, true);
    if (!r.stdout.trim().startsWith("{")) return undefined;
    try {
      return JSON.parse(r.stdout) as NpmListOutput;
    } catch {
      return undefined;
    }
  }

  /** `npm outdated --json`. Exit code is 1 when outdated packages exist; JSON is still on stdout. */
  async outdated(projectDir: string): Promise<Record<string, NpmOutdatedEntry> | undefined> {
    const r = await this.run("npm", ["outdated", "--json"], projectDir, true);
    if (!r.stdout.trim()) return {};
    try {
      return JSON.parse(r.stdout) as Record<string, NpmOutdatedEntry>;
    } catch {
      return undefined;
    }
  }

  /** `npm audit --json`. */
  async audit(projectDir: string): Promise<NpmAuditOutput | undefined> {
    const r = await this.run("npm", ["audit", "--json"], projectDir, true);
    if (!r.stdout.trim().startsWith("{")) return undefined;
    try {
      return JSON.parse(r.stdout) as NpmAuditOutput;
    } catch {
      return undefined;
    }
  }
}

export interface NpmListDependencyNode {
  version?: string;
  resolved?: string;
  dependencies?: Record<string, NpmListDependencyNode>;
  problems?: string[];
}

export interface NpmListOutput {
  name?: string;
  dependencies?: Record<string, NpmListDependencyNode>;
}

export interface NpmOutdatedEntry {
  current?: string;
  wanted: string;
  latest: string;
  dependent?: string;
}

export interface NpmAuditAdvisory {
  severity: "info" | "low" | "moderate" | "high" | "critical";
  via: (string | { title?: string; url?: string; severity?: string })[];
  range?: string;
  nodes?: string[];
}

export interface NpmAuditOutput {
  vulnerabilities?: Record<string, NpmAuditAdvisory>;
}
