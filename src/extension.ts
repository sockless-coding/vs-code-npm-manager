import * as vscode from "vscode";
import { NpmPanel } from "./panel/NpmPanel";
import {
  HostResponsePayload,
  InitialState,
  ProjectInfo,
  RegistryInfo,
  WebviewRequest
} from "./panel/messaging";
import { HttpClient, HttpError } from "./npm/httpClient";
import { SearchService, mergeSearchResults } from "./npm/search";
import { MetadataService } from "./npm/metadata";
import { RegistryRegistry } from "./npm/registries";
import { PackageManagerCli } from "./node/cli";
import { ProjectRegistry } from "./projects/discovery";
import { InstalledService } from "./projects/installed";
import { MutationService } from "./projects/mutations";

const ALL_REGISTRIES = "All registries";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("npm Package Manager");
  context.subscriptions.push(output);

  const registries = new RegistryRegistry(context);
  registries.refresh();

  const http = new HttpClient((url) => registries.getAuthHeader(url));
  const search = new SearchService(http);
  const metadata = new MetadataService(http);

  const cli = new PackageManagerCli(output);
  const projects = new ProjectRegistry();
  context.subscriptions.push(projects);
  projects.start();
  await projects.refresh();

  const installed = new InstalledService(projects, cli, registries, metadata, {
    progress: (message, done) =>
      NpmPanel.instance?.sendEvent({ type: "event", event: "progress", message, done }),
    enriched: (phase, packages) =>
      NpmPanel.instance?.sendEvent({ type: "event", event: "installedEnriched", phase, packages })
  });
  const mutations = new MutationService(projects, cli, output);

  const controller = new Controller(registries, http, search, metadata, installed, mutations, projects);

  projects.onDidChange(() => {
    installed.invalidate();
    NpmPanel.instance?.sendEvent({ type: "event", event: "projectsChanged" });
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("npmManager")) {
        registries.refresh();
        http.clearCache();
        cli.invalidateAvailability();
        installed.invalidate();
        NpmPanel.instance?.sendEvent({ type: "event", event: "settingsChanged" });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("npmManager.openManager", (uri?: vscode.Uri) => {
      const alreadyOpen = !!NpmPanel.instance;
      controller.setOpenScope(projects.resolveSelectionScope(uri));
      NpmPanel.createOrShow(context, (req) => controller.handle(req));
      if (alreadyOpen) {
        NpmPanel.instance?.sendEvent({
          type: "event",
          event: "scopeChanged",
          preselectProjectPaths: controller.openScope
        });
      }
    }),
    vscode.commands.registerCommand("npmManager.refresh", async () => {
      registries.refresh();
      http.clearCache();
      installed.invalidate();
      await projects.refresh();
      NpmPanel.instance?.sendEvent({ type: "event", event: "installedChanged" });
    })
  );
}

export function deactivate(): void {
  /* nothing to clean up beyond context.subscriptions */
}

class Controller {
  constructor(
    private readonly registries: RegistryRegistry,
    private readonly http: HttpClient,
    private readonly search: SearchService,
    private readonly metadata: MetadataService,
    private readonly installed: InstalledService,
    private readonly mutations: MutationService,
    private readonly projects: ProjectRegistry
  ) {}

  /** package.json paths to preselect, derived from the file the manager was opened from. */
  openScope: string[] = [];

  setOpenScope(paths: string[]): void {
    this.openScope = paths;
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
        NpmPanel.instance?.sendEvent({ type: "event", event: "installedChanged" });
        return { kind: "mutate", result };
      }

      case "openExternal":
        await vscode.env.openExternal(vscode.Uri.parse(req.url));
        return { kind: "openExternal" };

      default:
        return undefined;
    }
  }

  private initialState(): InitialState {
    return {
      defaultIncludePrerelease: vscode.workspace
        .getConfiguration("npmManager")
        .get<boolean>("defaultIncludePrerelease", false),
      registries: this.registryInfos(),
      projects: this.projectInfos(),
      minimumPackageAgeDays: this.minimumPackageAgeDays(),
      preselectProjectPaths: this.openScope
    };
  }

  private minimumPackageAgeDays(): number {
    const raw = vscode.workspace.getConfiguration("npmManager").get<number>("minimumPackageAgeDays", 7);
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
