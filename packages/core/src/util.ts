import { Disposable } from "./host";

/**
 * A minimal typed event emitter — the engine and its services fire events the
 * host forwards to the webview, without pulling in a VS Code `EventEmitter` or
 * assuming a Node `events` module is polyfilled in every target.
 */
export class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  event = (listener: (value: T) => void): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

/** Debounce `fn` by `ms`, coalescing bursts into a single trailing call. */
export function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let handle: ReturnType<typeof setTimeout> | undefined;
  return ((...args: any[]) => {
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => fn(...args), ms);
  }) as T;
}

/** Run `fn` over `items` with at most `limit` promises in flight. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
