/**
 * Webview-side bridge to whichever extension host is running the panel.
 *
 * Two transports are supported and picked automatically at load:
 *
 *  - **VS Code** — `acquireVsCodeApi()` for `postMessage` and real
 *    `getState`/`setState` persistence, with host messages arriving as `window`
 *    `"message"` events.
 *  - **Visual Studio (WebView2)** — `window.chrome.webview.postMessage` and
 *    `window.chrome.webview` `"message"` events, with `getState`/`setState`
 *    backed by `localStorage`.
 *
 * The public surface (`request`, `onHostEvent`, `onProgress`, `onScopeChange`,
 * `onInstalledEnriched`, `getState`, `setState`) is identical across both, so the
 * rest of the UI never has to know which host it is talking to.
 */

import type {
  HostMessage,
  HostResponsePayload,
  InstalledPackage,
  WebviewRequest
} from "@npm-manager/shared";

type EnrichPhase = "updates" | "vulnerabilities" | "done";
type HostEventName = "projectsChanged" | "installedChanged" | "settingsChanged";

interface HostTransport {
  postMessage(message: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
  /** Subscribe to inbound host messages; returns an unsubscribe. */
  onMessage(handler: (msg: HostMessage) => void): void;
}

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface WebView2Host {
  postMessage(message: unknown): void;
  addEventListener(type: "message", handler: (e: { data: unknown }) => void): void;
}

function createTransport(): HostTransport {
  const w = window as unknown as {
    acquireVsCodeApi?: typeof acquireVsCodeApi;
    chrome?: { webview?: WebView2Host };
  };

  if (typeof w.acquireVsCodeApi === "function") {
    const api = w.acquireVsCodeApi();
    return {
      postMessage: (m) => api.postMessage(m),
      getState: () => api.getState(),
      setState: (s) => api.setState(s),
      onMessage: (handler) =>
        window.addEventListener("message", (e: MessageEvent<HostMessage>) => handler(e.data))
    };
  }

  const webview = w.chrome?.webview;
  if (webview) {
    return {
      postMessage: (m) => webview.postMessage(m),
      getState: () => readLocal(),
      setState: (s) => writeLocal(s),
      onMessage: (handler) =>
        webview.addEventListener("message", (e) => handler(parseMaybeJson(e.data) as HostMessage))
    };
  }

  // Last-resort no-op transport (e.g. rendered outside any host for a screenshot).
  return {
    postMessage: () => undefined,
    getState: () => undefined,
    setState: () => undefined,
    onMessage: () => undefined
  };
}

const STATE_KEY = "npm-manager.webview-state";

function readLocal<T>(): T | undefined {
  try {
    const raw = window.localStorage.getItem(STATE_KEY);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function writeLocal<T>(state: T): void {
  try {
    window.localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    /* private mode / storage disabled — persistence is best-effort */
  }
}

function parseMaybeJson(data: unknown): unknown {
  return typeof data === "string" ? safeParse(data) : data;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const transport = createTransport();

let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const eventListeners = new Set<(event: HostEventName) => void>();
const progressListeners = new Set<(message: string, done: boolean) => void>();
const scopeListeners = new Set<(preselectProjectPaths: string[]) => void>();
const enrichedListeners = new Set<(phase: EnrichPhase, packages: InstalledPackage[]) => void>();

transport.onMessage((msg) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "response") {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.payload);
    else entry.reject(new Error(msg.error));
    return;
  }

  if (msg.type === "event") {
    if (msg.event === "progress") {
      progressListeners.forEach((l) => l(msg.message, msg.done));
    } else if (msg.event === "installedEnriched") {
      enrichedListeners.forEach((l) => l(msg.phase, msg.packages));
    } else if (msg.event === "scopeChanged") {
      scopeListeners.forEach((l) => l(msg.preselectProjectPaths));
    } else {
      eventListeners.forEach((l) => l(msg.event));
    }
  }
});

export function request<K extends WebviewRequest["kind"]>(
  req: Extract<WebviewRequest, { kind: K }>
): Promise<Extract<HostResponsePayload, { kind: K }>> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    transport.postMessage({ ...req, id });
  });
}

export function getState<T>(): T | undefined {
  return transport.getState<T>();
}

export function setState<T>(state: T): void {
  transport.setState(state);
}

export function onHostEvent(listener: (event: HostEventName) => void): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

export function onProgress(listener: (message: string, done: boolean) => void): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

export function onScopeChange(listener: (preselectProjectPaths: string[]) => void): () => void {
  scopeListeners.add(listener);
  return () => scopeListeners.delete(listener);
}

export function onInstalledEnriched(
  listener: (phase: EnrichPhase, packages: InstalledPackage[]) => void
): () => void {
  enrichedListeners.add(listener);
  return () => enrichedListeners.delete(listener);
}
