/**
 * Thin HTTP helper around the global `fetch` (Node 18+). Adds per-host auth
 * headers, retry with backoff on 429/5xx, and a small TTL response cache for
 * GET requests (package documents and search results are very cacheable).
 */

export type AuthProvider = (url: string) => Promise<string | undefined> | string | undefined;

interface CacheEntry {
  expires: number;
  body: any;
}

export class HttpClient {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly auth: AuthProvider = () => undefined) {}

  clearCache(): void {
    this.cache.clear();
  }

  async getJson<T = any>(url: string, opts: { ttlMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const ttlMs = opts.ttlMs ?? 0;
    const now = Date.now();
    if (ttlMs > 0) {
      const hit = this.cache.get(url);
      if (hit && hit.expires > now) {
        return hit.body as T;
      }
    }

    const body = await this.request(url, { signal: opts.signal });
    if (ttlMs > 0) {
      this.cache.set(url, { expires: now + ttlMs, body });
    }
    return body as T;
  }

  /**
   * POST a JSON body and parse the JSON response. Used for the registry's bulk
   * advisory endpoint. Cacheable via `ttlMs` — the cache key folds in the body
   * so different payloads to the same URL don't collide.
   */
  async postJson<T = any>(
    url: string,
    payload: unknown,
    opts: { ttlMs?: number; signal?: AbortSignal } = {}
  ): Promise<T> {
    const ttlMs = opts.ttlMs ?? 0;
    const now = Date.now();
    const body = JSON.stringify(payload);
    const cacheKey = ttlMs > 0 ? `POST ${url}\n${body}` : "";
    if (cacheKey) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.expires > now) {
        return hit.body as T;
      }
    }

    const result = await this.request(url, { signal: opts.signal, method: "POST", body });
    if (cacheKey) {
      this.cache.set(cacheKey, { expires: now + ttlMs, body: result });
    }
    return result as T;
  }

  private async request(
    url: string,
    opts: { signal?: AbortSignal; method?: string; body?: string } = {},
    attempt = 0
  ): Promise<any> {
    const { signal, method, body } = opts;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const token = await this.auth(url);
    if (token) {
      headers.Authorization = token;
    }

    let res: Response;
    try {
      res = await fetch(url, { headers, signal, method, body });
    } catch (err) {
      if (attempt < 3 && !signal?.aborted) {
        await delay(250 * 2 ** attempt);
        return this.request(url, opts, attempt + 1);
      }
      throw err;
    }

    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 400 * 2 ** attempt;
      await delay(wait);
      return this.request(url, opts, attempt + 1);
    }

    if (res.status === 401 || res.status === 403) {
      const e = new HttpError(`Authentication required for ${hostOf(url)}`, res.status);
      throw e;
    }
    if (res.status === 404) {
      throw new HttpError(`Not found: ${url}`, 404);
    }
    if (!res.ok) {
      throw new HttpError(`${method ?? "GET"} ${url} failed: ${res.status} ${res.statusText}`, res.status);
    }
    return res.json();
  }
}

export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HttpError";
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
