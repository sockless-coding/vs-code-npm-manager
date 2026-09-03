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

    const body = await this.request(url, opts.signal);
    if (ttlMs > 0) {
      this.cache.set(url, { expires: now + ttlMs, body });
    }
    return body as T;
  }

  private async request(url: string, signal?: AbortSignal, attempt = 0): Promise<any> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = await this.auth(url);
    if (token) {
      headers.Authorization = token;
    }

    let res: Response;
    try {
      res = await fetch(url, { headers, signal });
    } catch (err) {
      if (attempt < 3 && !signal?.aborted) {
        await delay(250 * 2 ** attempt);
        return this.request(url, signal, attempt + 1);
      }
      throw err;
    }

    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 400 * 2 ** attempt;
      await delay(wait);
      return this.request(url, signal, attempt + 1);
    }

    if (res.status === 401 || res.status === 403) {
      const e = new HttpError(`Authentication required for ${hostOf(url)}`, res.status);
      throw e;
    }
    if (res.status === 404) {
      throw new HttpError(`Not found: ${url}`, 404);
    }
    if (!res.ok) {
      throw new HttpError(`GET ${url} failed: ${res.status} ${res.statusText}`, res.status);
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
