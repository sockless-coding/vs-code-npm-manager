/**
 * Package search via the npm registry search endpoint.
 * https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md#get-v1search
 */

import { HttpClient } from "./httpClient";
import { PackageSummary } from "../panel/messaging";

interface SearchResponse {
  total: number;
  objects: SearchResultEntry[];
}

interface SearchResultEntry {
  package: {
    name: string;
    version: string;
    description?: string;
    keywords?: string[];
    date?: string;
    license?: string;
    links?: { npm?: string; homepage?: string; repository?: string; bugs?: string };
    author?: { name?: string };
    publisher?: { username?: string };
    maintainers?: { username: string }[];
  };
}

export interface SearchOptions {
  query: string;
  skip: number;
  take: number;
  includePrerelease: boolean;
  signal?: AbortSignal;
}

const NPMJS_HOST = "registry.npmjs.org";
const DOWNLOADS_TIMEOUT_MS = 1500;

export class SearchService {
  constructor(private readonly http: HttpClient) {}

  async search(
    registryUrl: string,
    registryName: string,
    opts: SearchOptions
  ): Promise<{ results: PackageSummary[]; hasMore: boolean }> {
    if (!opts.query.trim()) {
      return { results: [], hasMore: false };
    }

    const url = new URL("-/v1/search", registryUrl);
    url.searchParams.set("text", opts.query);
    url.searchParams.set("size", String(opts.take));
    url.searchParams.set("from", String(opts.skip));

    const body = await this.http.getJson<SearchResponse>(url.toString(), {
      ttlMs: 60 * 1000,
      signal: opts.signal
    });

    const objects = body.objects ?? [];
    const results = objects.map<PackageSummary>((entry) => {
      const p = entry.package;
      return {
        id: p.name,
        version: p.version,
        description: p.description ?? "",
        authors: normalizeAuthors(p),
        projectUrl: p.links?.homepage || p.links?.repository,
        licenseExpression: p.license && p.license !== "UNKNOWN" ? p.license : undefined,
        tags: p.keywords,
        source: registryName,
        latestPublished: p.date
      };
    });

    if (new URL(registryUrl).host === NPMJS_HOST && results.length > 0) {
      await withTimeout(this.applyDownloadCounts(results, opts.signal), DOWNLOADS_TIMEOUT_MS);
    }

    return { results, hasMore: opts.skip + objects.length < (body.total ?? 0) };
  }

  private async applyDownloadCounts(results: PackageSummary[], signal?: AbortSignal): Promise<void> {
    try {
      const names = results.map((r) => encodeURIComponent(r.id));
      const url = `https://api.npmjs.org/downloads/point/last-month/${names.join(",")}`;
      const body = await this.http.getJson<Record<string, { downloads?: number } | undefined>>(url, {
        ttlMs: 60 * 60 * 1000,
        signal
      });
      // A single-package request returns a flat object instead of a map keyed by name.
      if (results.length === 1 && typeof (body as any)?.downloads === "number") {
        results[0].totalDownloads = (body as any).downloads;
        return;
      }
      for (const r of results) {
        const d = body[r.id]?.downloads;
        if (typeof d === "number") r.totalDownloads = d;
      }
    } catch {
      /* best-effort only */
    }
  }
}

function normalizeAuthors(p: SearchResultEntry["package"]): string[] {
  if (p.author?.name) return [p.author.name];
  if (p.publisher?.username) return [p.publisher.username];
  if (p.maintainers?.length) return p.maintainers.map((m) => m.username);
  return [];
}

/** Race a promise against a timeout; resolves either way (errors are swallowed by the caller). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | void> {
  return Promise.race([promise, new Promise<void>((resolve) => setTimeout(resolve, ms))]);
}

/**
 * Merge results from multiple registries, keeping the first entry per id and
 * preserving the original (relevance) ordering of the first registry that returned it.
 */
export function mergeSearchResults(lists: PackageSummary[][]): PackageSummary[] {
  const byId = new Map<string, PackageSummary>();
  const order: string[] = [];
  for (const list of lists) {
    for (const pkg of list) {
      const key = pkg.id.toLowerCase();
      if (!byId.has(key)) {
        byId.set(key, pkg);
        order.push(key);
      }
    }
  }
  return order.map((k) => byId.get(k)!);
}
