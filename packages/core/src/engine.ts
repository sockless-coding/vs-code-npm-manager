/**
 * The host-agnostic engine behind the package-manager panel.
 *
 * `createEngine(host)` wires the registry/search/metadata/project/installed/
 * mutation services on top of a {@link HostServices} and returns an {@link Engine}
 * the host drives: it forwards webview requests to `handle()`, pipes `events` to
 * the webview, and calls `setOpenScope` / `refresh` in response to host commands.
 *
 * This is the code that used to live inside the VS Code extension's `activate()`
 * and its private `Controller` class.
 */

import * as fs from "fs";
import * as path from "path";
import {
  HostEvent,
  HostResponsePayload,
  InitialState,
  ProjectInfo,
  RegistryInfo,
  WebviewRequest
} from "@npm-manager/shared";
import { Disposable, HostServices } from "./host";
import { Emitter } from "./util";
import { HttpClient, HttpError } from "./npm/httpClient";
import { SearchService, mergeSearchResults } from "./npm/search";
import { MetadataService } from "./npm/metadata";
import { RegistryRegistry } from "./npm/registries";
import { PackageManagerCli } from "./node/cli";
import { ProjectRegistry } from "./projects/discovery";
import { InstalledService } from "./projects/installed";
import { MutationService } from "./projects/mutations";

const ALL_REGISTRIES = "All registries";

export interface Engine {
  /** Handle one webview request. */
  handle(req: WebviewRequest): Promise<HostResponsePayload | undefined>;
  /** Host events (progress, enrichment, project/settings changes) to forward to the webview. */
  readonly events: Emitter<HostEvent>;
  /** Set the package.json paths the panel should preselect for install/update. */
  setOpenScope(packageJsonPaths: string[]): void;
  /** Set directories the panel may offer to initialise a package.json in. */
  setInitializableDirs(dirs: { dir: string; name: string }[]): void;
  /** Resolve the file the manager was opened from to a full selection scope. */
  resolveSelectionScope(packageJsonPath: string | undefined): string[];
  /** The currently discovered projects. */
  listProjects(): ProjectInfo[];
  /** Re-read registries, projects and drop caches; fires `installedChanged`. */
  refresh(): Promise<void>;
  /** Initial project discovery; call once before first use. */
  ready(): Promise<void>;
  dispose(): void;
}

export function createEngine(host: HostServices): Engine {
  return new EngineImpl(host);
}

class EngineImpl implements Engine {
  readonly events = new Emitter<HostEvent>();

  private readonly registries: RegistryRegistry;
  private readonly http: HttpClient;
  private readonly search: SearchService;
  private readonly metadata: MetadataService;
  private readonly cli: PackageManagerCli;
  private readonly projects: ProjectRegistry;
  private readonly installed: InstalledService;
  private readonly mutations: MutationService;
  private readonly disposables: Disposable[] = [];

  private openScope: string[] = [];
  private initializableDirs: { dir: string; name: string }[] = [];

  constructor(private readonly host: HostServices) {
    this.registries = new RegistryRegistry(host);
    this.registries.refresh();

    this.http = new HttpClient((url) => this.registries.getAuthHeader(url));
    this.search = new SearchService(this.http);
    this.metadata = new MetadataService(this.http);

    this.cli = new PackageManagerCli(host);
    this.projects = new ProjectRegistry(host);
    this.projects.start();
    this.disposables.push(this.projects);

    this.installed = new InstalledService(host, this.projects, this.cli, this.registries, this.metadata, {
      progress: (message, done) => this.events.fire({ type: "event", event: "progress", message, done }),
      enriched: (phase, packages) =>
        this.events.fire({ type: "event", event: "installedEnriched", phase, packages })
    });
    this.mutations = new MutationService(host, this.projects, this.cli);

    this.disposables.push(
      this.projects.onDidChange(() => {
        this.installed.invalidate();
        this.events.fire({ type: "event", event: "projectsChanged" });
      })
    );

    this.disposables.push(
      host.onConfigChange(() => {
        this.registries.refresh();
        this.http.clearCache();
        this.cli.invalidateAvailability();
        this.installed.invalidate();
        this.events.fire({ type: "event", event: "settingsChanged" });
      })
    );
  }

  ready(): Promise<void> {
    return this.projects.refresh();
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) d.dispose();
    this.events.dispose();
  }

  setOpenScope(paths: string[]): void {
    this.openScope = paths;
  }

  setInitializableDirs(dirs: { dir: string; name: string }[]): void {
    this.initializableDirs = dirs;
  }

  resolveSelectionScope(packageJsonPath: string | undefined): string[] {
    return this.projects.resolveSelectionScope(packageJsonPath);
  }

  listProjects(): ProjectInfo[] {
    return this.projectInfos();
  }

  async refresh(): Promise<void> {
    this.registries.refresh();
    this.http.clearCache();
    this.installed.invalidate();
    await this.projects.refresh();
    this.events.fire({ type: "event", event: "installedChanged" });
  }

  async handle(req: WebviewRequest): Promise<HostResponsePayload | undefined> {
    switch (req.kind) {
      case "ready":
        return { kind: "ready", initialState: this.initialState() };

      case "listRegistries":
        return { kind: "listRegistries", registries: this.registryInfos() };

      case "listProjects":
        return { kind: "listProjects", projects: this.projectInfos() };

      case "search":
        return this.doSearch(req);

      case "getPackageDetail":
        return this.doDetail(req);

      case "listInstalled": {
        const { packages, packageManagerAvailable } = await this.installed.list(req.includeTransitive);
        return { kind: "listInstalled", packages, packageManagerAvailable };
      }

      case "mutate": {
        const registry = req.request.source ? this.registries.findByName(req.request.source) : undefined;
        const result = await this.mutations.apply(req.request, registry?.url);
        this.events.fire({ type: "event", event: "installedChanged" });
        return { kind: "mutate", result };
      }

      case "initPackageJson":
        return this.doInitPackageJson(req.dir);

      case "openExternal":
        await this.host.openExternal(req.url);
        return { kind: "openExternal" };

      default:
        return undefined;
    }
  }

  /* ------------------------------ handlers ------------------------------- */

  private async doInitPackageJson(dir: string): Promise<HostResponsePayload> {
    const target = path.resolve(dir);
    const file = path.join(target, "package.json");
    if (!fs.existsSync(file)) {
      fs.mkdirSync(target, { recursive: true });
      const name = sanitizePackageName(path.basename(target));
      fs.writeFileSync(file, JSON.stringify({ name, version: "1.0.0" }, null, 2) + "\n", "utf8");
    }
    this.initializableDirs = this.initializableDirs.filter((d) => path.resolve(d.dir) !== target);
    await this.projects.refresh();
    const project = this.projects.findByPath(file);
    this.setOpenScope(project ? [project.info.path] : []);
    this.events.fire({ type: "event", event: "projectsChanged" });
    this.events.fire({ type: "event", event: "installedChanged" });
    if (!project) throw new Error(`Could not read the package.json created at ${file}`);
    return { kind: "initPackageJson", project: project.info };
  }

  private initialState(): InitialState {
    return {
      defaultIncludePrerelease: this.host.getConfig<boolean>("defaultIncludePrerelease", false),
      registries: this.registryInfos(),
      projects: this.projectInfos(),
      minimumPackageAgeDays: this.minimumPackageAgeDays(),
      preselectProjectPaths: this.openScope,
      initializableDirs: this.initializableDirs
    };
  }

  private minimumPackageAgeDays(): number {
    const raw = this.host.getConfig<number>("minimumPackageAgeDays", 7);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  private registryInfos(): RegistryInfo[] {
    return this.registries.getRegistries().map((r) => ({
      name: r.name,
      url: r.url,
      enabled: r.enabled,
      requiresAuth: r.hasAuth
    }));
  }

  private projectInfos(): ProjectInfo[] {
    return this.projects.getProjects().map((p) => p.info);
  }

  private targetRegistries(source: string) {
    const enabled = this.registries.getEnabledRegistries();
    if (source && source !== ALL_REGISTRIES) {
      return enabled.filter((r) => r.name === source);
    }
    return enabled;
  }

  private async doSearch(req: Extract<WebviewRequest, { kind: "search" }>): Promise<HostResponsePayload> {
    const targets = this.targetRegistries(req.source);
    const lists = await Promise.all(
      targets.map((registry) =>
        this.withAuthRetry(registry.name, () =>
          this.search.search(registry.url, registry.name, {
            query: req.query,
            skip: req.skip,
            take: req.take,
            includePrerelease: req.includePrerelease
          })
        ).catch(() => ({ results: [], hasMore: false }))
      )
    );
    const results = mergeSearchResults(lists.map((l) => l.results));
    return {
      kind: "search",
      results,
      hasMore: lists.some((l) => l.hasMore)
    };
  }

  private async doDetail(req: Extract<WebviewRequest, { kind: "getPackageDetail" }>): Promise<HostResponsePayload> {
    const targets = this.targetRegistries(req.source);
    const registry =
      targets[0] ?? this.registries.registryForPackage(req.packageId) ?? this.registries.getEnabledRegistries()[0];
    if (!registry) {
      throw new Error("No npm registry is configured.");
    }
    const detail = await this.withAuthRetry(registry.name, () =>
      this.metadata.getPackageDetail(registry.url, registry.name, req.packageId, req.includePrerelease)
    );
    return { kind: "getPackageDetail", detail };
  }

  /** Run `fn`; on a 401/403 prompt for credentials once and retry. */
  private async withAuthRetry<T>(registryName: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        const saved = await this.registries.promptForCredentials(registryName);
        if (saved) {
          this.http.clearCache();
          return fn();
        }
      }
      throw err;
    }
  }
}

/** A directory name reduced to something npm will accept as a package name. */
function sanitizePackageName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return cleaned || "package";
}
